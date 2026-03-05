import { useState, useEffect, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import toast from 'react-hot-toast'

const PHRASES = [
  'You built the intelligence. We give it a voice.',
  'From notebook to API in 60 seconds.',
  'Data Alchemy created it. Deploy Alchemy unleashes it.',
  'Your model deserves to be seen.',
  'Where machine learning meets the world.',
]

export default function Welcome({ onUploadStart, onUploadProgress, onUploadComplete }) {
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [fadePhrase, setFadePhrase] = useState(true)
  const [uploading, setUploading] = useState(false)

  // Rotate phrases
  useEffect(() => {
    const interval = setInterval(() => {
      setFadePhrase(false)
      setTimeout(() => {
        setPhraseIdx(i => (i + 1) % PHRASES.length)
        setFadePhrase(true)
      }, 500)
    }, 3500)
    return () => clearInterval(interval)
  }, [])

  const processZip = useCallback(async (file) => {
    if (!file.name.endsWith('.zip')) {
      toast.error('Please upload a ZIP file')
      return
    }
    setUploading(true)
    onUploadStart()

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await axios.post('/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          onUploadProgress(Math.round((e.loaded / e.total) * 100))
        },
      })
      toast.success('Model loaded successfully!')
      onUploadComplete(res.data)
    } catch (err) {
      const msg = err.response?.data?.detail || 'Upload failed'
      toast.error(msg)
      setUploading(false)
    }
  }, [onUploadComplete])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => files[0] && processZip(files[0]),
    accept: { 'application/zip': ['.zip'] },
    multiple: false,
    disabled: uploading,
  })

  return (
    <div className="relative z-10 flex flex-col items-center justify-center min-h-screen px-4">

      {/* Top decorative line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-30" />

      {/* Header */}
      <div className="text-center mb-16">
        {/* Logo symbol */}
        <div className="flex justify-center mb-6">
          <div className="relative w-20 h-20">
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-500/20 to-purple-600/20 animate-pulse-glow" />
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-cyan-500/10 to-purple-600/10 border border-cyan-500/30" />
            <div className="absolute inset-0 flex items-center justify-center">
              <AlchemySymbol />
            </div>
          </div>
        </div>

        {/* Title */}
        <h1
          className="font-display text-5xl md:text-7xl font-bold mb-3 tracking-widest uppercase"
          style={{
            background: 'linear-gradient(135deg, #00f5ff 0%, #7c3aed 50%, #f97316 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'drop-shadow(0 0 30px rgba(0,245,255,0.4))',
          }}
        >
          Deploy Alchemy
        </h1>

        {/* Subtitle line */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="h-px w-16 bg-gradient-to-r from-transparent to-cyan-500/50" />
          <span className="text-cyan-500/70 font-mono text-xs tracking-[0.3em] uppercase">
            ML Deployment Forge
          </span>
          <div className="h-px w-16 bg-gradient-to-l from-transparent to-cyan-500/50" />
        </div>

        {/* Rotating phrase */}
        <p
          className="font-body text-lg md:text-xl text-slate-300 max-w-lg mx-auto transition-all duration-500"
          style={{ opacity: fadePhrase ? 1 : 0 }}
        >
          {PHRASES[phraseIdx]}
        </p>
      </div>

      {/* Upload zone */}
      <div
        {...getRootProps()}
        className={`
          relative w-full max-w-lg cursor-pointer rounded-2xl p-px transition-all duration-300
          ${isDragActive
            ? 'shadow-[0_0_60px_rgba(0,245,255,0.4)]'
            : 'hover:shadow-[0_0_40px_rgba(0,245,255,0.2)]'}
          ${uploading ? 'pointer-events-none' : ''}
        `}
        style={{
          background: isDragActive
            ? 'linear-gradient(135deg, #00f5ff, #7c3aed)'
            : 'linear-gradient(135deg, rgba(0,245,255,0.3), rgba(124,58,237,0.3))',
        }}
      >
        <input {...getInputProps()} />
        <div className="rounded-2xl bg-surface/90 backdrop-blur-xl p-10 text-center">

          {uploading ? (
            <UploadingState progress={uploadProgress} />
          ) : (
            <IdleState isDragActive={isDragActive} />
          )}

        </div>
      </div>

      {/* What's inside hint */}
      {!uploading && (
        <div className="mt-8 flex flex-wrap justify-center gap-4 text-xs font-mono text-slate-500">
          <ArtifactBadge label="AutoGluon Model" color="cyan" />
          <ArtifactBadge label="autofeat.pkl" color="purple" />
          <ArtifactBadge label="features_eng.json" color="ember" />
          <ArtifactBadge label="processed_data.csv" color="jade" />
          <ArtifactBadge label="profile_report.html" color="gold" />
        </div>
      )}

      {/* Bottom decorative */}
      <div className="absolute bottom-6 left-0 right-0 flex justify-center">
        <span className="text-slate-700 font-mono text-xs tracking-widest">
          ◆ STATELESS · NO DATA STORED · SESSION-ONLY ◆
        </span>
      </div>

      {/* Corner decorations */}
      <CornerDecor position="top-left" />
      <CornerDecor position="top-right" />
      <CornerDecor position="bottom-left" />
      <CornerDecor position="bottom-right" />
    </div>
  )
}

function IdleState({ isDragActive }) {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className={`
          w-16 h-16 rounded-xl flex items-center justify-center
          border transition-all duration-300
          ${isDragActive
            ? 'border-cyan-400 bg-cyan-400/10 shadow-[0_0_20px_rgba(0,245,255,0.3)]'
            : 'border-border bg-card'}
        `}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke={isDragActive ? '#00f5ff' : '#4a6a9a'} strokeWidth="1.5" strokeLinecap="round"/>
            <polyline points="17,8 12,3 7,8" stroke={isDragActive ? '#00f5ff' : '#4a6a9a'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="12" y1="3" x2="12" y2="15" stroke={isDragActive ? '#00f5ff' : '#4a6a9a'} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      </div>
      <p className={`font-body text-lg font-medium mb-2 transition-colors duration-300 ${isDragActive ? 'text-cyan-300' : 'text-slate-300'}`}>
        {isDragActive ? 'Release to summon your model' : 'Drop your ZIP to begin'}
      </p>
      <p className="text-slate-500 text-sm">
        or <span className="text-cyan-500 hover:text-cyan-300 cursor-pointer transition-colors">click to browse</span>
      </p>
      <p className="text-slate-600 text-xs mt-3 font-mono">ZIP from Data Alchemy · includes CSV &amp; profile report</p>
    </>
  )
}

function UploadingState({ progress }) {
  return (
    <div className="py-2">
      <div className="flex justify-center mb-4">
        <div className="relative w-12 h-12">
          <svg className="animate-spin" viewBox="0 0 50 50">
            <circle cx="25" cy="25" r="20" fill="none" stroke="#1a2d50" strokeWidth="3" />
            <circle cx="25" cy="25" r="20" fill="none" stroke="#00f5ff" strokeWidth="3"
              strokeDasharray={`${progress * 1.257} 125.7`}
              strokeLinecap="round"
              style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-cyan-400 text-xs font-mono">{progress}%</span>
          </div>
        </div>
      </div>
      <p className="text-cyan-300 font-body text-base mb-1">Transmuting your model...</p>
      <div className="w-full bg-border rounded-full h-1 mt-3">
        <div
          className="h-1 rounded-full transition-all duration-300"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #7c3aed, #00f5ff)',
          }}
        />
      </div>
    </div>
  )
}

function ArtifactBadge({ label, color }) {
  const colors = {
    cyan:   'border-cyan-900/50 text-cyan-700',
    purple: 'border-purple-900/50 text-purple-700',
    ember:  'border-orange-900/50 text-orange-700',
    jade:   'border-emerald-900/50 text-emerald-700',
    gold:   'border-yellow-900/50 text-yellow-700',
  }
  return (
    <span className={`border rounded px-2 py-1 ${colors[color]}`}>
      {label}
    </span>
  )
}

function CornerDecor({ position }) {
  const classes = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  }
  return (
    <div className={`absolute ${classes[position]} w-8 h-8 opacity-20`}>
      <div className="w-full h-full border-cyan-400"
        style={{
          borderTopWidth: position.includes('top') ? '1px' : 0,
          borderBottomWidth: position.includes('bottom') ? '1px' : 0,
          borderLeftWidth: position.includes('left') ? '1px' : 0,
          borderRightWidth: position.includes('right') ? '1px' : 0,
        }}
      />
    </div>
  )
}

function AlchemySymbol() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="8" stroke="#00f5ff" strokeWidth="1" opacity="0.6" />
      <line x1="20" y1="4" x2="20" y2="36" stroke="#00f5ff" strokeWidth="0.8" opacity="0.4" />
      <line x1="4" y1="20" x2="36" y2="20" stroke="#00f5ff" strokeWidth="0.8" opacity="0.4" />
      <line x1="7" y1="7" x2="33" y2="33" stroke="#7c3aed" strokeWidth="0.8" opacity="0.4" />
      <line x1="33" y1="7" x2="7" y2="33" stroke="#7c3aed" strokeWidth="0.8" opacity="0.4" />
      <circle cx="20" cy="20" r="3" fill="#00f5ff" opacity="0.8" />
      <circle cx="20" cy="8" r="1.5" fill="#f97316" opacity="0.6" />
      <circle cx="20" cy="32" r="1.5" fill="#f97316" opacity="0.6" />
      <circle cx="8" cy="20" r="1.5" fill="#f97316" opacity="0.6" />
      <circle cx="32" cy="20" r="1.5" fill="#f97316" opacity="0.6" />
    </svg>
  )
}
