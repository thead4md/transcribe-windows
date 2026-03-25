# Magyar Beszédfelismerő — Windows Offline

100% local speech-to-text for Windows using [faster-whisper](https://github.com/SYSTRAN/faster-whisper). Automatically uses your NVIDIA GPU if available, falls back to CPU. No internet required after setup. No API keys. Full privacy.

## Features

- **File upload** — drag & drop MP3, WAV, OGG, FLAC, M4A, MP4, AAC, WebM (up to 450 MB)
- **Live recording** — record from your microphone and transcribe
- **Hungarian + English** — optimized for Hungarian with English support and auto-detection
- **NVIDIA GPU acceleration** — uses CUDA float16 for fast inference when a GPU is available
- **CPU fallback** — works on any Windows PC, just slower (uses int8 quantization)
- **Word timestamps** — get per-word timing for each transcription
- **Fully offline** — after initial model download, works without any network connection

## Requirements

- Windows 10/11
- Python 3.10+
- NVIDIA GPU with CUDA (optional but recommended)
- ffmpeg (optional, for broad format support)

## Quick Start

```
git clone https://github.com/thead4md/transcribe-windows.git
cd transcribe-windows
setup.bat
start.bat
```

Then open **http://localhost:5000** in your browser.

The setup script auto-detects your GPU and installs the right dependencies. First transcription downloads the model (~1.6 GB), then everything works offline.

## Manual Setup

```
:: Create virtual environment
python -m venv .venv
.venv\Scripts\activate

:: Install dependencies (choose one)
pip install -r requirements-gpu.txt    :: NVIDIA GPU
pip install -r requirements-cpu.txt    :: CPU only

:: Build frontend (requires Node.js)
cd frontend
npm install
npm run build
cd ..

:: Install ffmpeg (optional)
winget install ffmpeg

:: Run
python server.py
```

## Choosing a Model

Set the `WHISPER_MODEL` environment variable:

| Model | Params | GPU Speed | CPU Speed | Accuracy | VRAM |
|---|---|---|---|---|---|
| `tiny` | 39M | ~32x RT | ~6x RT | ★★☆☆☆ | ~1 GB |
| `base` | 74M | ~16x RT | ~3x RT | ★★★☆☆ | ~1 GB |
| `small` | 244M | ~6x RT | ~1x RT | ★★★☆☆ | ~2 GB |
| `medium` | 769M | ~2x RT | ~0.3x RT | ★★★★☆ | ~5 GB |
| **`large-v3-turbo`** | 809M | ~3x RT | ~0.5x RT | ★★★★★ | ~6 GB |
| `large-v3` | 1.5B | ~1x RT | ~0.2x RT | ★★★★★ | ~10 GB |

**Default: `large-v3-turbo`** — best accuracy-to-speed ratio.

```
:: Use a smaller model for CPU-only machines
set WHISPER_MODEL=small
python server.py

:: Or for maximum accuracy with a beefy GPU
set WHISPER_MODEL=large-v3
python server.py
```

"RT" = real-time. 3x RT means 60 seconds of audio transcribes in ~20 seconds.

For CPU-only machines with limited RAM, use `small` or `medium`.

## Project Structure

```
transcribe-windows/
├── server.py               # FastAPI backend with faster-whisper
├── requirements.txt        # Default (CPU) dependencies
├── requirements-gpu.txt    # NVIDIA GPU dependencies
├── requirements-cpu.txt    # CPU-only dependencies
├── setup.bat               # One-click Windows setup
├── start.bat               # One-click launcher (opens browser)
├── frontend/
│   ├── src/App.tsx          # React frontend
│   ├── src/index.css        # Styles
│   ├── src/main.tsx         # Entry point
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## How It Works

1. `start.bat` launches the Python server on port 5000 and opens your browser
2. The React frontend is served as static files by the same server
3. Audio is sent to the local `/api/transcribe` endpoint
4. faster-whisper runs inference on your GPU (CUDA) or CPU
5. Nothing leaves your machine

## Hugging Face Token (Optional)

The first run downloads the model from Hugging Face. Without a token you may see a warning about unauthenticated requests and slower download speeds. To fix this:

1. Create a free account at [huggingface.co](https://huggingface.co)
2. Generate a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
3. Create a `.env` file in the project root:

```
copy .env.example .env
:: Edit .env and add your token:
:: HF_TOKEN=hf_your_token_here
```

Or set it before running:

```
set HF_TOKEN=hf_your_token_here
python server.py
```

This is completely optional — the app works without a token, just with slower initial downloads.

## Troubleshooting

**"Server not reachable"** — Make sure `start.bat` is running. Check the terminal window for errors.

**Slow first transcription** — The model is being downloaded (~1.6 GB). This only happens once.

**CUDA out of memory** — Use a smaller model: `set WHISPER_MODEL=small` then run `python server.py`.

**"ffmpeg not found"** — Install with `winget install ffmpeg` or download from [ffmpeg.org](https://ffmpeg.org/download.html).

**GPU not detected** — Make sure you have the latest NVIDIA drivers and CUDA Toolkit installed: [developer.nvidia.com/cuda-downloads](https://developer.nvidia.com/cuda-downloads)

---

Created with [Perplexity Computer](https://www.perplexity.ai/computer)
