"""
Magyar Beszédfelismerő — Windows Offline Server
Runs 100% locally using faster-whisper.
  • NVIDIA GPU (CUDA) — if available, uses GPU for fast inference
  • CPU fallback    — works on any Windows PC, just slower
No internet required after initial model download. No API keys.
"""

import os
import sys
import time
import tempfile
import subprocess
import shutil
import warnings
from pathlib import Path

# ─── Hugging Face token (optional, suppresses rate-limit warnings) ───────────
# Set HF_TOKEN as an environment variable, or create a .env file with:
#   HF_TOKEN=hf_your_token_here
# Get your free token at: https://huggingface.co/settings/tokens

_hf_token = os.environ.get("HF_TOKEN", "")
if _hf_token:
    os.environ["HF_TOKEN"] = _hf_token
    os.environ["HUGGING_FACE_HUB_TOKEN"] = _hf_token
else:
    # Suppress the "unauthenticated requests" warning when no token is set
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    warnings.filterwarnings("ignore", message=".*unauthenticated.*")

from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI(title="Magyar Beszédfelismerő — Windows Offline")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Configuration ────────────────────────────────────────────────────────────

# Model options (set via WHISPER_MODEL env var or change default here):
#
#   Model          Params   VRAM     Speed (RTX 3060)   Accuracy
#   ───────────    ──────   ──────   ────────────────   ────────
#   tiny           39M      ~1 GB   ~32x RT            ★★☆☆☆
#   base           74M      ~1 GB   ~16x RT            ★★★☆☆
#   small          244M     ~2 GB   ~6x RT             ★★★☆☆
#   medium         769M     ~5 GB   ~2x RT             ★★★★☆
#   large-v3       1.5B     ~10 GB  ~1x RT             ★★★★★
#   large-v3-turbo 809M     ~6 GB   ~3x RT             ★★★★★
#
# Default: large-v3-turbo — best accuracy/speed tradeoff.
# On CPU-only machines, consider "small" or "medium".

DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")

# Compute type: float16 for GPU, int8 for CPU (auto-detected)
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "auto")

MAX_UPLOAD_BYTES = 450 * 1024 * 1024  # 450 MB

# Load .env file if it exists (for HF_TOKEN etc.)
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())
    if os.environ.get("HF_TOKEN"):
        os.environ["HUGGING_FACE_HUB_TOKEN"] = os.environ["HF_TOKEN"]

# ─── Device & model detection ────────────────────────────────────────────────

_model = None
_device = None
_compute_type = None


def get_model():
    """Load the faster-whisper model (lazy, first call downloads it)."""
    global _model, _device, _compute_type

    if _model is not None:
        return _model

    from faster_whisper import WhisperModel

    # Auto-detect device
    if COMPUTE_TYPE != "auto":
        _compute_type = COMPUTE_TYPE
    else:
        _compute_type = None  # will be resolved below

    # Try CUDA first
    try:
        import torch
        if torch.cuda.is_available():
            _device = "cuda"
            _compute_type = _compute_type or "float16"
            gpu_name = torch.cuda.get_device_name(0)
            print(f"  GPU detected: {gpu_name}")
        else:
            _device = "cpu"
            _compute_type = _compute_type or "int8"
    except ImportError:
        # No torch — try CUDA anyway via ctranslate2
        try:
            import ctranslate2
            if "cuda" in ctranslate2.get_supported_compute_types("cuda"):
                _device = "cuda"
                _compute_type = _compute_type or "float16"
            else:
                _device = "cpu"
                _compute_type = _compute_type or "int8"
        except Exception:
            _device = "cpu"
            _compute_type = _compute_type or "int8"

    print(f"  Device: {_device} | Compute: {_compute_type} | Model: {DEFAULT_MODEL}")
    print(f"  Loading model (first run downloads ~1.6 GB)...")

    _model = WhisperModel(
        DEFAULT_MODEL,
        device=_device,
        compute_type=_compute_type,
    )

    print(f"  Model ready")
    return _model


# ─── Helpers ─────────────────────────────────────────────────────────────────

SUPPORTED_EXTENSIONS = {
    "mp3", "wav", "ogg", "flac", "m4a", "mp4", "aac", "webm", "wma", "opus",
}


def get_file_extension(filename: str | None, content_type: str | None) -> str:
    if filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext in SUPPORTED_EXTENSIONS:
            return ext

    ct_map = {
        "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/ogg": "ogg", "audio/flac": "flac",
        "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a",
        "audio/aac": "aac", "audio/webm": "webm",
        "video/webm": "webm", "video/mp4": "mp4",
    }
    return ct_map.get(content_type or "", "webm")


def convert_to_wav(input_path: str, ext: str) -> str:
    """Convert to 16 kHz mono WAV via ffmpeg for best results."""
    if ext == "wav":
        return input_path

    wav_path = input_path.rsplit(".", 1)[0] + ".wav"

    # Try ffmpeg from PATH or common Windows locations
    ffmpeg_cmd = "ffmpeg"
    if not shutil.which("ffmpeg"):
        # Check common locations
        for candidate in [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            os.path.join(os.path.dirname(__file__), "ffmpeg", "ffmpeg.exe"),
        ]:
            if os.path.isfile(candidate):
                ffmpeg_cmd = candidate
                break

    try:
        subprocess.run(
            [
                ffmpeg_cmd, "-y", "-i", input_path,
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                wav_path,
            ],
            capture_output=True, check=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return wav_path
    except FileNotFoundError:
        print("  Warning: ffmpeg not found — transcribing without conversion", file=sys.stderr)
        return input_path
    except subprocess.CalledProcessError as e:
        print(f"  Warning: ffmpeg error: {e.stderr.decode()[:200]}", file=sys.stderr)
        return input_path


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "hu-stt-windows",
        "version": "1.0.0",
        "model": DEFAULT_MODEL,
        "device": _device or "detecting...",
        "compute_type": _compute_type or "auto",
        "backend": f"faster-whisper ({_device or 'auto'})",
    }


@app.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str = Form(default="hu"),
    timestamps: str = Form(default="word"),
):
    """
    Transcribe audio locally using faster-whisper.
    Supports: mp3, wav, ogg, flac, m4a, mp4, aac, webm
    """
    model = get_model()

    try:
        audio_bytes = await audio.read()

        if len(audio_bytes) < 100:
            raise HTTPException(status_code=400, detail="Audio file is too small or empty")

        if len(audio_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum: {MAX_UPLOAD_BYTES // (1024*1024)} MB",
            )

        ext = get_file_extension(audio.filename, audio.content_type)

        with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            audio_path = convert_to_wav(tmp_path, ext)

            lang_param = None if language == "auto" else language

            size_mb = len(audio_bytes) / (1024 * 1024)
            print(f"  Transcribing: {audio.filename or 'recording'} ({size_mb:.1f} MB, .{ext})")

            t0 = time.time()

            segments_iter, info = model.transcribe(
                audio_path,
                language=lang_param,
                word_timestamps=(timestamps == "word"),
                beam_size=5,
                vad_filter=True,
            )

            # Collect segments
            all_text = []
            words = []
            for segment in segments_iter:
                all_text.append(segment.text)
                if timestamps == "word" and segment.words:
                    for w in segment.words:
                        words.append({
                            "text": w.word,
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                            "speaker_id": None,
                        })

            elapsed = time.time() - t0
            text = " ".join(all_text).strip()

            detected_lang = info.language if info else language
            lang_prob = round(info.language_probability, 2) if info else None

            print(f"  Done in {elapsed:.1f}s | Language: {detected_lang} ({lang_prob})")

            return {
                "text": text,
                "language_code": detected_lang,
                "words": words,
                "success": True,
                "processing_time_s": round(elapsed, 2),
                "model": DEFAULT_MODEL,
                "device": _device,
            }

        finally:
            for p in [tmp_path, tmp_path.rsplit(".", 1)[0] + ".wav"]:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    except HTTPException:
        raise
    except Exception as e:
        print(f"  Error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")


# ─── Serve frontend ─────────────────────────────────────────────────────────

DIST = Path(__file__).parent / "frontend" / "dist"

if DIST.exists():
    if (DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/")
    async def root():
        return FileResponse(str(DIST / "index.html"))

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        return FileResponse(str(DIST / "index.html"))


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 5000))

    print()
    print("=" * 58)
    print("  Magyar Beszedfelismero - Windows Offline Mode")
    print("  100% local | faster-whisper | No internet needed")
    print(f"  Model: {DEFAULT_MODEL}")
    print("=" * 58)
    print(f"\n  Open in browser: http://localhost:{port}\n")

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
