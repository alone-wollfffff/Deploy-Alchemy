import { useState, useEffect } from 'react'
import { Toaster } from 'react-hot-toast'
import Welcome from './components/Welcome'
import ScanAnimation from './components/ScanAnimation'
import Dashboard from './components/Dashboard'
import ParticleCanvas from './components/ParticleCanvas'
import NameModal from './components/NameModal'

// ── Upload processing overlay shown between Welcome and Scan ────────────────
function UploadingOverlay({ progress }) {
  return (
    <div className="relative z-10 flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm text-center">
        {/* Pulsing ring */}
        <div className="flex justify-center mb-8">
          <div className="relative w-24 h-24">
            <div className="absolute inset-0 rounded-full upload-active border border-cyan-500/40" />
            <div className="absolute inset-3 rounded-full bg-gradient-to-br from-cyan-500/20 to-purple-600/20 animate-pulse" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl">⚗️</span>
            </div>
          </div>
        </div>

        <p className="font-mono text-xs text-cyan-400 uppercase tracking-widest mb-3">
          Transmuting artifact...
        </p>

        {/* Progress bar */}
        <div className="h-1 bg-border rounded-full overflow-hidden mb-2">
          <div
            className="h-1 rounded-full transition-all duration-300"
            style={{
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #7c3aed, #00f5ff)',
              boxShadow: '0 0 12px rgba(0,245,255,0.6)'
            }}
          />
        </div>
        <p className="font-mono text-slate-600 text-xs">{progress}%</p>
      </div>
    </div>
  )
}

export default function App() {
  // phases: welcome | uploading | naming | scanning | dashboard
  const [phase, setPhase]                   = useState('welcome')
  const [deployments, setDeployments]       = useState([])
  const [activeDeploymentId, setActiveDeploymentId] = useState(null)
  const [pendingUpload, setPendingUpload]   = useState(null)
  const [uploadProgress, setUploadProgress] = useState(0)

  useEffect(() => {
    const handleUnload = () => {
      deployments.forEach(d => {
        fetch(`/api/session/${d.sessionId}`, { method: 'DELETE', keepalive: true })
      })
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [deployments])

  const finalizeDeployment = (sessionData, chosenName) => {
    const newDeploy = {
      id:         sessionData.session_id,
      sessionId:  sessionData.session_id,
      name:       chosenName ||
                  sessionData.metadata?.model_name_from_data ||
                  sessionData.metadata?.original_filename?.replace('.csv','') ||
                  `Model ${deployments.length + 1}`,
      metadata:   sessionData.metadata,
      filesFound: sessionData.files_found,
      uploadedAt: new Date(),
    }
    setDeployments(prev => [...prev, newDeploy])
    setActiveDeploymentId(newDeploy.id)
    return newDeploy
  }

  // Welcome calls this when upload STARTS (pass progress setter down)
  const handleUploadStart = () => {
    setPhase('uploading')
    setUploadProgress(0)
  }

  // Welcome calls this when upload finishes
  const handleUploadComplete = (sessionData) => {
    const defaultName =
      sessionData.metadata?.model_name_from_data ||
      sessionData.metadata?.original_filename?.replace('.csv','') ||
      `Model ${deployments.length + 1}`
    setPendingUpload({ sessionData, defaultName })
    setPhase('naming')
  }

  // Dashboard "Add Deployment"
  const handleDashboardUpload = (sessionData) => {
    const defaultName =
      sessionData.metadata?.model_name_from_data ||
      sessionData.metadata?.original_filename?.replace('.csv','') ||
      `Model ${deployments.length + 1}`
    setPendingUpload({ sessionData, defaultName })
    setPhase('naming')
  }

  const handleNamingComplete = (name) => {
    if (!pendingUpload) return
    const newDeploy = finalizeDeployment(pendingUpload.sessionData, name)
    setActiveDeploymentId(newDeploy.id)
    setPendingUpload(null)
    if (deployments.length > 0) setPhase('dashboard')
    else setPhase('scanning')
  }

  const activeDeployment = deployments.find(d => d.id === activeDeploymentId)

  return (
    <div className="relative min-h-screen bg-void overflow-hidden">
      <ParticleCanvas />

      {phase === 'welcome' && (
        <Welcome
          onUploadStart={handleUploadStart}
          onUploadProgress={setUploadProgress}
          onUploadComplete={handleUploadComplete}
        />
      )}

      {phase === 'uploading' && (
        <UploadingOverlay progress={uploadProgress} />
      )}

      {phase === 'naming' && pendingUpload && (
        <NameModal
          defaultName={pendingUpload.defaultName}
          onConfirm={handleNamingComplete}
        />
      )}

      {phase === 'scanning' && pendingUpload === null && activeDeployment && (
        <ScanAnimation
          metadata={activeDeployment.metadata}
          filesFound={activeDeployment.filesFound}
          onComplete={() => setPhase('dashboard')}
        />
      )}

      {phase === 'dashboard' && activeDeployment && (
        <div className="dashboard-entrance">
          <Dashboard
            deployments={deployments}
            activeDeployment={activeDeployment}
            onSwitchDeployment={setActiveDeploymentId}
            onNewUpload={handleDashboardUpload}
            onRemoveDeployment={(id) => {
              const remaining = deployments.filter(d => d.id !== id)
              setDeployments(remaining)
              if (remaining.length > 0) setActiveDeploymentId(remaining[0].id)
            }}
            onUpdateDeployment={(id, updates) => {
              setDeployments(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d))
            }}
          />
        </div>
      )}

      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'rgba(17,29,53,0.9)',
            color: '#e2e8f0',
            border: '1px solid #1a2d50',
            fontFamily: 'Outfit, sans-serif',
            backdropFilter: 'blur(12px)',
          },
          success: { iconTheme: { primary: '#00f5ff', secondary: '#050810' } },
          error:   { iconTheme: { primary: '#f43f5e', secondary: '#050810' } },
        }}
      />
    </div>
  )
}
