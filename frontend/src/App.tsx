import { useState, useRef, useCallback, useEffect } from 'react'
import { Mic, MicOff, Download, Trash2, Globe, Loader2, AlertCircle, CheckCircle2, ChevronDown, Upload, FileAudio, X, Cpu, Wifi, WifiOff } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type Language = 'hu' | 'en' | 'auto'
type Status = 'idle' | 'recording' | 'processing' | 'success' | 'error'
type InputMode = 'record' | 'upload'

interface TranscriptSegment {
  id: string
  text: string
  language: string
  timestamp: Date
  durationMs: number
  source: 'mic' | 'file'
  fileName?: string
  processingTime?: number
}

interface WordTimestamp {
  text: string
  start: number
  end: number
}

interface ServerHealth {
  status: string
  model: string
  backend: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LANG_LABELS: Record<Language, { label: string; native: string }> = {
  hu:   { label: 'Magyar',  native: 'HU' },
  en:   { label: 'English', native: 'EN' },
  auto: { label: 'Auto',    native: 'AUTO' },
}

const ACCEPTED_EXTENSIONS = '.mp3,.wav,.ogg,.flac,.m4a,.mp4,.aac,.webm,.wma'

const MAX_FILE_SIZE_MB = 450
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

// Same-origin — the Python server serves both API and frontend
const API_BASE = "";

// ─── Waveform bars component ─────────────────────────────────────────────────

function WaveformBars({ active, color }: { active: boolean; color: string }) {
  const bars = Array.from({ length: 20 }, (_, i) => i)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', height: '40px' }}>
      {bars.map((i) => (
        <div
          key={i}
          style={{
            width: '3px',
            height: '100%',
            backgroundColor: color,
            borderRadius: '2px',
            transformOrigin: 'center',
            animation: active
              ? `waveform ${0.6 + (i % 5) * 0.12}s ease-in-out ${(i * 0.05) % 0.6}s infinite`
              : 'none',
            transform: active ? undefined : 'scaleY(0.25)',
            opacity: active ? (i % 3 === 0 ? 1 : 0.6) : 0.3,
            transition: 'all 0.3s ease',
          }}
        />
      ))}
    </div>
  )
}

// ─── File size formatter ─────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [language, setLanguage] = useState<Language>('hu')
  const [status, setStatus] = useState<Status>('idle')
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [currentWords, setCurrentWords] = useState<WordTimestamp[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [showLangMenu, setShowLangMenu] = useState(false)
  const [totalWords, setTotalWords] = useState(0)
  const [inputMode, setInputMode] = useState<InputMode>('upload')
  const [dragOver, setDragOver] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null)
  const [serverOnline, setServerOnline] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const durationIntervalRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const langMenuRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // ─── Server health check ──────────────────────────────────────────────

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/health`)
        if (res.ok) {
          const data = await res.json()
          setServerHealth(data)
          setServerOnline(true)
        } else {
          setServerOnline(false)
        }
      } catch {
        setServerOnline(false)
      }
    }
    checkHealth()
    const interval = setInterval(checkHealth, 10000)
    return () => clearInterval(interval)
  }, [])

  // Close lang menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setShowLangMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Auto-scroll transcript
  useEffect(() => {
    if (segments.length > 0) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [segments])

  // ─── Recording logic ──────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      })
      streamRef.current = stream

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const durationMs = Date.now() - startTimeRef.current
        await transcribeAudio(blob, durationMs, mimeType, 'mic')
      }

      recorder.start(250)
      startTimeRef.current = Date.now()
      setStatus('recording')
      setErrorMsg('')

      durationIntervalRef.current = window.setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 100)
    } catch (err: any) {
      setErrorMsg(
        err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access and try again.'
          : `Microphone error: ${err.message}`
      )
      setStatus('error')
    }
  }, [language])

  const stopRecording = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current)
      durationIntervalRef.current = null
    }
    setRecordingDuration(0)

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStatus('processing')
  }, [])

  // ─── Unified transcription function ───────────────────────────────────

  const transcribeAudio = useCallback(
    async (blob: Blob, durationMs: number, mimeType: string, source: 'mic' | 'file', fileName?: string) => {
      setStatus('processing')
      setCurrentWords([])

      const formData = new FormData()
      const ext = mimeType.includes('ogg') ? 'ogg'
        : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
        : mimeType.includes('wav') ? 'wav'
        : mimeType.includes('flac') ? 'flac'
        : mimeType.includes('m4a') || mimeType.includes('mp4') ? 'mp4'
        : mimeType.includes('aac') ? 'aac'
        : 'webm'
      formData.append('audio', blob, fileName || `recording.${ext}`)
      formData.append('language', language)
      formData.append('timestamps', 'word')

      try {
        const res = await fetch(`${API_BASE}/api/transcribe`, {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: res.statusText }))
          throw new Error(err.detail || `HTTP ${res.status}`)
        }

        const data = await res.json()

        if (!data.text?.trim()) {
          setStatus('idle')
          if (source === 'file') {
            setErrorMsg('Nem sikerült szöveget felismerni a fájlban. / No speech detected in the file.')
            setStatus('error')
            setTimeout(() => setStatus('idle'), 5000)
          }
          return
        }

        const segment: TranscriptSegment = {
          id: crypto.randomUUID(),
          text: data.text,
          language: data.language_code || language,
          timestamp: new Date(),
          durationMs,
          source,
          fileName,
          processingTime: data.processing_time_s,
        }

        setSegments((prev) => [...prev, segment])
        setCurrentWords(data.words || [])
        setTotalWords((prev) => prev + data.text.trim().split(/\s+/).length)
        setStatus('success')
        setSelectedFile(null)

        setTimeout(() => setStatus('idle'), 2000)
      } catch (err: any) {
        setErrorMsg(`Transcription failed: ${err.message}`)
        setStatus('error')
        setTimeout(() => setStatus('idle'), 5000)
      }
    },
    [language]
  )

  // ─── Recording toggle ─────────────────────────────────────────────────

  const toggleRecording = useCallback(() => {
    if (status === 'recording') {
      stopRecording()
    } else if (status === 'idle' || status === 'success' || status === 'error') {
      startRecording()
    }
  }, [status, startRecording, stopRecording])

  // ─── File upload logic ─────────────────────────────────────────────────

  const validateFile = useCallback((file: File): string | null => {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return `A fájl túl nagy (${formatFileSize(file.size)}). Max: ${MAX_FILE_SIZE_MB} MB.`
    }
    if (file.size < 100) {
      return 'A fájl üres vagy túl kicsi.'
    }
    const ext = file.name.split('.').pop()?.toLowerCase()
    const validExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'aac', 'webm', 'wma', 'opus']
    if (ext && !validExts.includes(ext)) {
      return `Nem támogatott fájlformátum: .${ext}. Támogatott: MP3, WAV, OGG, FLAC, M4A, MP4, AAC, WebM`
    }
    return null
  }, [])

  const handleFileSelect = useCallback((file: File) => {
    const error = validateFile(file)
    if (error) {
      setErrorMsg(error)
      setStatus('error')
      setTimeout(() => setStatus('idle'), 5000)
      return
    }
    setSelectedFile(file)
    setErrorMsg('')
  }, [validateFile])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
    e.target.value = ''
  }, [handleFileSelect])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }, [handleFileSelect])

  const startFileTranscription = useCallback(async () => {
    if (!selectedFile || status === 'processing') return
    const mimeType = selectedFile.type || 'audio/mpeg'
    await transcribeAudio(selectedFile, 0, mimeType, 'file', selectedFile.name)
  }, [selectedFile, status, transcribeAudio])

  const clearSelectedFile = useCallback(() => {
    setSelectedFile(null)
    setErrorMsg('')
  }, [])

  // ─── Transcript management ────────────────────────────────────────────

  const clearTranscript = useCallback(() => {
    setSegments([])
    setCurrentWords([])
    setTotalWords(0)
    setStatus('idle')
    setErrorMsg('')
    setSelectedFile(null)
  }, [])

  const downloadTranscript = useCallback(() => {
    if (segments.length === 0) return
    const content = segments
      .map(
        (s) =>
          `[${s.timestamp.toLocaleTimeString('hu-HU')} | ${s.language.toUpperCase()} | ${s.source === 'file' ? `Fájl: ${s.fileName}` : 'Mikrofon'}${s.processingTime ? ` | ${s.processingTime}s` : ''}]\n${s.text}`
      )
      .join('\n\n---\n\n')
    const header = `Magyar Beszédfelismerő — Offline átírás\nDátum: ${new Date().toLocaleString('hu-HU')}\nModell: ${serverHealth?.model || 'faster-whisper'}\n${'═'.repeat(50)}\n\n`
    const blob = new Blob([header + content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `atiras_offline_${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [segments, serverHealth])

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const isRecording = status === 'recording'
  const isProcessing = status === 'processing'
  const isDisabled = isProcessing || !serverOnline

  const micBtnColor = isRecording ? 'var(--rec)' : 'var(--accent)'
  const micBtnGlow = isRecording ? 'var(--shadow-rec)' : 'var(--shadow-accent)'

  // Short model name for display
  const modelShort = serverHealth?.model?.split('/').pop()?.replace('whisper-', '') || '...'

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>

      {/* ── Header ── */}
      <header style={{
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%)',
        padding: 'var(--space-4) var(--space-6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {/* SVG Logo */}
          <svg aria-label="Magyar Beszédfelismerő" viewBox="0 0 36 36" width="36" height="36" fill="none" style={{ flexShrink: 0 }}>
            <rect width="36" height="36" rx="8" fill="var(--surface-3)" />
            <circle cx="18" cy="18" r="10" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 2" />
            <rect x="14" y="10" width="8" height="12" rx="4" fill="var(--accent)" opacity="0.9" />
            <path d="M12 20c0 3.314 2.686 6 6 6s6-2.686 6-6" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="18" y1="26" x2="18" y2="29" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="15" y1="29" x2="21" y2="29" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--text)', letterSpacing: '-0.01em' }}>
              Magyar Beszédfelismerő
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Cpu size={11} />
              Offline · Windows · faster-whisper
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {/* Server status */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
            color: serverOnline ? 'var(--success)' : 'var(--error)',
          }}>
            {serverOnline ? <WifiOff size={11} title="Offline — running locally" /> : <Wifi size={11} />}
            <span>{serverOnline ? 'Lokális' : 'Nincs kapcsolat'}</span>
          </div>

          {/* Stats */}
          {segments.length > 0 && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
              <span style={{ color: 'var(--accent)' }}>{segments.length}</span> szegmens · <span style={{ color: 'var(--accent)' }}>{totalWords}</span> szó
            </div>
          )}

          {/* Language selector */}
          <div ref={langMenuRef} style={{ position: 'relative' }}>
            <button
              data-testid="btn-language"
              onClick={() => setShowLangMenu((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                background: 'var(--surface-3)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: '6px 10px',
                fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                transition: 'var(--transition)', cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <Globe size={14} color="var(--accent)" />
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--accent)' }}>
                {LANG_LABELS[language].native}
              </span>
              <ChevronDown size={12} style={{ transition: 'transform 0.2s', transform: showLangMenu ? 'rotate(180deg)' : 'none' }} />
            </button>
            {showLangMenu && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', overflow: 'hidden',
                boxShadow: 'var(--shadow-lg)', minWidth: '140px', zIndex: 100,
                animation: 'fade-in 0.15s var(--ease)',
              }}>
                {(Object.keys(LANG_LABELS) as Language[]).map((lang) => (
                  <button
                    key={lang}
                    data-testid={`lang-option-${lang}`}
                    onClick={() => { setLanguage(lang); setShowLangMenu(false) }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      width: '100%', padding: '10px 16px',
                      background: language === lang ? 'var(--accent-glow)' : 'transparent',
                      color: language === lang ? 'var(--accent)' : 'var(--text-muted)',
                      fontSize: 'var(--text-sm)', textAlign: 'left',
                      borderBottom: '1px solid var(--border)',
                      transition: 'var(--transition)', cursor: 'pointer',
                    }}
                    onMouseEnter={e => { if (language !== lang) e.currentTarget.style.background = 'var(--surface-3)' }}
                    onMouseLeave={e => { if (language !== lang) e.currentTarget.style.background = 'transparent' }}
                  >
                    <span>{LANG_LABELS[lang].label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                      {LANG_LABELS[lang].native}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'var(--space-8) var(--space-6)', gap: 'var(--space-6)', maxWidth: '800px', margin: '0 auto', width: '100%' }}>

        {/* ── Model info bar ── */}
        {serverHealth && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-full)', padding: '5px 14px',
          }}>
            <Cpu size={12} color="var(--accent)" />
            <span>Modell: <span style={{ color: 'var(--accent)' }}>{modelShort}</span></span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{serverHealth.backend}</span>
          </div>
        )}

        {/* ── Server offline warning ── */}
        {!serverOnline && (
          <div style={{
            width: '100%', display: 'flex', gap: 'var(--space-3)', alignItems: 'center',
            background: 'var(--error-bg)', border: '1px solid var(--error)',
            borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
            fontSize: 'var(--text-sm)', color: 'var(--error)',
          }}>
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 600 }}>A helyi szerver nem elérhető</div>
              <div style={{ fontSize: 'var(--text-xs)', opacity: 0.8, marginTop: '2px' }}>
                Indítsd el: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: '3px' }}>start.bat</code>
              </div>
            </div>
          </div>
        )}

        {/* ── Input Mode Tabs ── */}
        <div style={{
          display: 'flex', gap: '2px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '3px',
          width: 'fit-content',
        }}>
          <button
            data-testid="tab-upload"
            onClick={() => setInputMode('upload')}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              padding: '8px 20px', borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)', fontWeight: 500,
              background: inputMode === 'upload' ? 'var(--accent-glow)' : 'transparent',
              color: inputMode === 'upload' ? 'var(--accent)' : 'var(--text-muted)',
              border: inputMode === 'upload' ? '1px solid rgba(98, 208, 255, 0.25)' : '1px solid transparent',
              cursor: 'pointer', transition: 'var(--transition)',
            }}
          >
            <Upload size={15} />
            <span>Fájl feltöltés</span>
          </button>
          <button
            data-testid="tab-record"
            onClick={() => { setInputMode('record'); setSelectedFile(null) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              padding: '8px 20px', borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)', fontWeight: 500,
              background: inputMode === 'record' ? 'var(--accent-glow)' : 'transparent',
              color: inputMode === 'record' ? 'var(--accent)' : 'var(--text-muted)',
              border: inputMode === 'record' ? '1px solid rgba(98, 208, 255, 0.25)' : '1px solid transparent',
              cursor: 'pointer', transition: 'var(--transition)',
            }}
          >
            <Mic size={15} />
            <span>Felvétel</span>
          </button>
        </div>

        {/* ── File Upload Card ── */}
        {inputMode === 'upload' && (
          <div className="animate-fade-in" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
              data-testid="input-file"
            />

            {/* Drop Zone */}
            {!selectedFile && !isProcessing && (
              <div
                data-testid="drop-zone"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: '100%',
                  background: dragOver ? 'var(--accent-glow)' : 'var(--surface)',
                  border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border-2)'}`,
                  borderRadius: 'var(--radius-xl)',
                  padding: 'var(--space-12) var(--space-8)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-4)',
                  cursor: serverOnline ? 'pointer' : 'not-allowed',
                  opacity: serverOnline ? 1 : 0.5,
                  transition: 'all 0.25s var(--ease)',
                }}
              >
                <div style={{
                  width: 64, height: 64, borderRadius: '50%',
                  background: dragOver ? 'var(--accent-glow-2)' : 'var(--accent-glow)',
                  border: `2px solid ${dragOver ? 'var(--accent)' : 'rgba(98, 208, 255, 0.3)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.25s var(--ease)',
                }}>
                  <Upload size={24} color="var(--accent)" />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 'var(--text-base)', color: 'var(--text)', fontWeight: 500, marginBottom: 'var(--space-1)' }}>
                    {dragOver ? 'Engedd el a fájlt' : 'Húzd ide a hangfájlt'}
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                    vagy <span style={{ color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>válassz fájlt</span> a gépedről
                  </div>
                </div>
                <div style={{
                  fontSize: 'var(--text-xs)', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
                  display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', justifyContent: 'center',
                }}>
                  {['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'MP4', 'AAC', 'WebM'].map(fmt => (
                    <span key={fmt} style={{
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', padding: '2px 6px',
                    }}>{fmt}</span>
                  ))}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                  Max. {MAX_FILE_SIZE_MB} MB · Feldolgozás 100% lokálisan
                </div>
              </div>
            )}

            {/* Selected File Preview */}
            {selectedFile && !isProcessing && (
              <div className="animate-slide-up" style={{
                width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xl)', padding: 'var(--space-6)',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-5)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 'var(--radius-lg)',
                    background: 'var(--accent-glow)', border: '1px solid rgba(98, 208, 255, 0.25)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <FileAudio size={22} color="var(--accent)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 'var(--text-sm)', color: 'var(--text)', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{selectedFile.name}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {formatFileSize(selectedFile.size)}
                      {selectedFile.type && ` · ${selectedFile.type.split('/')[1]?.toUpperCase()}`}
                    </div>
                  </div>
                  <button
                    data-testid="btn-remove-file"
                    onClick={clearSelectedFile}
                    style={{
                      width: 32, height: 32, borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', transition: 'var(--transition)', flexShrink: 0,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--error)'; e.currentTarget.style.color = 'var(--error)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
                  >
                    <X size={14} />
                  </button>
                </div>

                <div style={{
                  fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-full)', padding: '4px 12px', alignSelf: 'center',
                }}>
                  Nyelv: <span style={{ color: 'var(--accent)' }}>{LANG_LABELS[language].label}</span>
                  {language === 'auto' && ' (automatikus)'}
                </div>

                <button
                  data-testid="btn-transcribe-file"
                  onClick={startFileTranscription}
                  disabled={!serverOnline}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)',
                    width: '100%', padding: '12px 24px',
                    background: serverOnline ? 'linear-gradient(135deg, var(--accent-2), var(--accent))' : 'var(--surface-3)',
                    border: 'none', borderRadius: 'var(--radius-lg)',
                    fontSize: 'var(--text-sm)', fontWeight: 600,
                    color: serverOnline ? 'var(--bg)' : 'var(--text-faint)',
                    cursor: serverOnline ? 'pointer' : 'not-allowed',
                    transition: 'all 0.25s var(--ease)',
                    boxShadow: serverOnline ? 'var(--shadow-accent)' : 'none',
                  }}
                  onMouseEnter={e => {
                    if (serverOnline) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 0 32px var(--accent-glow-2)' }
                  }}
                  onMouseLeave={e => {
                    if (serverOnline) { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--shadow-accent)' }
                  }}
                >
                  <Cpu size={16} />
                  Átírás lokálisan
                </button>
              </div>
            )}

            {/* Processing state */}
            {isProcessing && inputMode === 'upload' && (
              <div className="animate-fade-in" style={{
                width: '100%', background: 'var(--surface)', border: '1px solid var(--accent)',
                borderRadius: 'var(--radius-xl)', padding: 'var(--space-8)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-5)',
                boxShadow: '0 0 30px var(--accent-glow)',
              }}>
                <Loader2 size={36} color="var(--accent)" className="animate-spin" />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 'var(--text-base)', color: 'var(--text)', fontWeight: 500, marginBottom: 'var(--space-1)' }}>
                    Lokális átírás folyamatban...
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {selectedFile?.name} · {modelShort} · faster-whisper
                  </div>
                </div>
                <WaveformBars active={true} color="var(--accent)" />
              </div>
            )}
          </div>
        )}

        {/* ── Recording Card (mic mode) ── */}
        {inputMode === 'record' && (
          <div className="animate-fade-in" style={{
            width: '100%', background: 'var(--surface)',
            border: `1px solid ${isRecording ? 'var(--rec)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-xl)', padding: 'var(--space-8)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-6)',
            transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
            boxShadow: isRecording ? '0 0 40px var(--rec-glow), var(--shadow-md)' : 'var(--shadow-md)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: isRecording ? 'var(--rec)' : isProcessing ? 'var(--accent)' : status === 'success' ? 'var(--success)' : status === 'error' ? 'var(--error)' : 'var(--text-faint)',
                boxShadow: isRecording ? '0 0 8px var(--rec)' : isProcessing ? '0 0 8px var(--accent)' : 'none',
                animation: isRecording ? 'glow-pulse 1s ease-in-out infinite' : 'none',
              }} />
              <span style={{ color: isRecording ? 'var(--rec)' : isProcessing ? 'var(--accent)' : status === 'success' ? 'var(--success)' : status === 'error' ? 'var(--error)' : 'var(--text-faint)' }}>
                {isRecording ? `FELVÉTEL · ${formatDuration(recordingDuration)}` :
                 isProcessing ? 'FELDOLGOZÁS...' :
                 status === 'success' ? 'KÉSZ' :
                 status === 'error' ? 'HIBA' :
                 'KÉSZEN ÁLL'}
              </span>
            </div>

            <WaveformBars active={isRecording || isProcessing} color={isRecording ? 'var(--rec)' : 'var(--accent)'} />

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isRecording && (
                <>
                  <div style={{ position: 'absolute', width: 96, height: 96, borderRadius: '50%', border: '2px solid var(--rec)', opacity: 0.5, animation: 'pulse-ring 1.2s ease-out infinite' }} />
                  <div style={{ position: 'absolute', width: 110, height: 110, borderRadius: '50%', border: '1px solid var(--rec)', opacity: 0.25, animation: 'pulse-ring 1.2s ease-out 0.4s infinite' }} />
                </>
              )}
              <button
                data-testid="btn-record"
                onClick={toggleRecording}
                disabled={isDisabled}
                style={{
                  width: 80, height: 80, borderRadius: '50%',
                  background: isRecording ? 'rgba(239,83,80,0.15)' : 'var(--accent-glow)',
                  border: `2px solid ${micBtnColor}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.5 : 1,
                  transition: 'all 0.25s var(--ease)', boxShadow: micBtnGlow,
                }}
                onMouseEnter={e => {
                  if (!isDisabled) { e.currentTarget.style.transform = 'scale(1.07)'; e.currentTarget.style.boxShadow = isRecording ? '0 0 48px var(--rec-glow-2)' : '0 0 40px var(--accent-glow-2)' }
                }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = micBtnGlow }}
                aria-label={isRecording ? 'Felvétel leállítása' : 'Felvétel indítása'}
              >
                {isProcessing ? <Loader2 size={28} color="var(--accent)" className="animate-spin" /> :
                 isRecording ? <MicOff size={28} color="var(--rec)" /> :
                 <Mic size={28} color="var(--accent)" />}
              </button>
            </div>

            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center' }}>
              {isRecording ? 'Kattints a felvétel leállításához' :
               isProcessing ? 'Lokális feldolgozás folyamatban...' :
               'Kattints a mikrofon ikonra a felvételhez'}
            </div>

            <div style={{
              fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-full)', padding: '4px 12px',
            }}>
              Aktív nyelv: <span style={{ color: 'var(--accent)' }}>{LANG_LABELS[language].label}</span>
              {language === 'auto' && ' (automatikus felismerés)'}
            </div>
          </div>
        )}

        {/* ── Error Banner ── */}
        {status === 'error' && errorMsg && (
          <div className="animate-slide-up" style={{
            width: '100%', display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start',
            background: 'var(--error-bg)', border: '1px solid var(--error)',
            borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
            fontSize: 'var(--text-sm)', color: 'var(--error)',
          }}>
            <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* ── Success Banner ── */}
        {status === 'success' && segments.length > 0 && (
          <div className="animate-slide-up" style={{
            width: '100%', display: 'flex', gap: 'var(--space-2)', alignItems: 'center',
            background: 'var(--success-bg)', border: '1px solid var(--success)',
            borderRadius: 'var(--radius-lg)', padding: 'var(--space-3) var(--space-4)',
            fontSize: 'var(--text-sm)', color: 'var(--success)',
          }}>
            <CheckCircle2 size={16} />
            <span>
              Sikeresen átírva
              {segments[segments.length - 1]?.processingTime && (
                <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.8 }}>
                  {' '}· {segments[segments.length - 1].processingTime}s
                </span>
              )}
            </span>
          </div>
        )}

        {/* ── Transcript Panel ── */}
        {segments.length > 0 && (
          <div className="animate-slide-up" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text)', margin: 0 }}>Átírt szöveg</h2>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button
                  data-testid="btn-download"
                  onClick={downloadTranscript}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', padding: '7px 14px',
                    fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                    transition: 'var(--transition)', cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
                >
                  <Download size={14} /><span>Letöltés</span>
                </button>
                <button
                  data-testid="btn-clear"
                  onClick={clearTranscript}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', padding: '7px 14px',
                    fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                    transition: 'var(--transition)', cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--error)'; e.currentTarget.style.color = 'var(--error)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
                >
                  <Trash2 size={14} /><span>Törlés</span>
                </button>
              </div>
            </div>

            <div style={{ maxHeight: '420px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-1)' }}>
              {segments.map((seg, idx) => (
                <div key={seg.id} data-testid={`segment-${idx}`} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)', padding: 'var(--space-4) var(--space-5)',
                  animation: 'slide-up 0.4s var(--ease) both',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
                        background: 'var(--accent-glow)', color: 'var(--accent)',
                        border: '1px solid rgba(79,195,247,0.3)',
                        borderRadius: 'var(--radius-full)', padding: '2px 8px',
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>{seg.language}</span>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
                        background: seg.source === 'file' ? 'rgba(156, 136, 255, 0.1)' : 'rgba(102, 187, 106, 0.1)',
                        color: seg.source === 'file' ? '#b0a0ff' : 'var(--success)',
                        border: `1px solid ${seg.source === 'file' ? 'rgba(156, 136, 255, 0.25)' : 'rgba(102, 187, 106, 0.25)'}`,
                        borderRadius: 'var(--radius-full)', padding: '2px 8px',
                        display: 'flex', alignItems: 'center', gap: '4px',
                      }}>
                        {seg.source === 'file' ? <FileAudio size={10} /> : <Mic size={10} />}
                        {seg.source === 'file' ? 'fájl' : 'mikrofon'}
                      </span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>#{idx + 1}</span>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {seg.timestamp.toLocaleTimeString('hu-HU')}
                      {seg.processingTime && <span> · {seg.processingTime}s</span>}
                      {seg.fileName && (
                        <span style={{ marginLeft: '6px', opacity: 0.7 }} title={seg.fileName}>
                          · {seg.fileName.length > 20 ? seg.fileName.slice(0, 17) + '...' : seg.fileName}
                        </span>
                      )}
                    </div>
                  </div>
                  <p style={{ fontSize: 'var(--text-base)', color: 'var(--text)', lineHeight: 1.7, margin: 0, maxWidth: 'none' }}>
                    {seg.text}
                  </p>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>

            {segments.length > 1 && (
              <div style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', padding: 'var(--space-4) var(--space-5)',
              }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-3)' }}>
                  Összesített szöveg
                </div>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.8, margin: 0, maxWidth: 'none' }}>
                  {segments.map((s) => s.text).join(' ')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Empty State ── */}
        {segments.length === 0 && status === 'idle' && inputMode === 'record' && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 'var(--space-8) 0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 'var(--space-4)' }}>🎙️</div>
            <p style={{ margin: 0, maxWidth: 'none' }}>
              Nyomja meg a mikrofon gombot a felvétel megkezdéséhez.<br />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                Press the microphone button to start recording.
              </span>
            </p>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: 'var(--space-4) var(--space-6)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 'var(--space-2)',
      }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Cpu size={11} />
          100% offline · faster-whisper · {modelShort} · Windows
        </div>
        <a
          href="https://www.perplexity.ai/computer"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textDecoration: 'none', transition: 'var(--transition)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}
        >
          Created with Perplexity Computer
        </a>
      </footer>
    </div>
  )
}
