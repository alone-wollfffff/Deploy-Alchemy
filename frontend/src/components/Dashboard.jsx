import { useState } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import toast from 'react-hot-toast'
import ModelOverview from './ModelOverview'
import Leaderboard from './Leaderboard'
import Analytics from './Analytics'
import PredictionForm from './PredictionForm'
import BatchPrediction from './BatchPrediction'
import WhatIfBuilder from './WhatIfBuilder'
import ExportPanel from './ExportPanel'

const TABS = [
  { id: 'overview',    label: 'Overview',    icon: <IconOverview /> },
  { id: 'leaderboard', label: 'Leaderboard', icon: <IconLeaderboard /> },
  { id: 'analytics',   label: 'Analytics',   icon: <IconAnalytics /> },
  { id: 'predict',     label: 'Predict',     icon: <IconPredict /> },
  { id: 'batch',       label: 'Batch',       icon: <IconBatch /> },
  { id: 'whatif',      label: 'What-If',     icon: <IconWhatIf /> },
  { id: 'export',      label: 'Export',      icon: <IconExport /> },
]

// ── SVG icon components ────────────────────────────────────────────────────
function IconOverview()    { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> }
function IconLeaderboard() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h.01M8 10h.01M8 14h.01M8 18h.01"/><rect x="3" y="3" width="7" height="18" rx="1"/><path d="M13 8h8M13 12h8M13 16h5"/></svg> }
function IconAnalytics()   { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> }
function IconPredict()     { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> }
function IconBatch()       { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> }
function IconWhatIf()      { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> }
function IconExport()      { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> }

// ── Lightning bolt logo icon ────────────────────────────────────────────────
function LogoBolt() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="boltGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00f5ff" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <polygon
        points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"
        fill="url(#boltGrad)"
        stroke="none"
        style={{ filter: 'drop-shadow(0 0 4px rgba(0,245,255,0.6))' }}
      />
    </svg>
  )
}

export default function Dashboard({ deployments, activeDeployment, onSwitchDeployment, onNewUpload, onRemoveDeployment, onUpdateDeployment }) {
  const [activeTab, setActiveTab]     = useState('overview')
  const [uploading, setUploading]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const { getRootProps, getInputProps } = useDropzone({
    onDrop: async (files) => {
      if (!files[0]) return
      setUploading(true)
      const formData = new FormData()
      formData.append('file', files[0])
      try {
        const res = await axios.post('/api/upload', formData)
        onNewUpload(res.data)
      } catch (err) {
        toast.error(err.response?.data?.detail || 'Upload failed')
      } finally {
        setUploading(false)
      }
    },
    accept: { 'application/zip': ['.zip'] },
    multiple: false,
  })

  if (!activeDeployment) return null
  const meta       = activeDeployment?.metadata
  const filesFound = activeDeployment?.filesFound || {}

  return (
    <div className="relative z-10 flex h-screen overflow-hidden">

      {/* ── Fixed Sidebar ─────────────────────────────────────────────────── */}
      <aside className="flex-shrink-0 w-64 h-full flex flex-col border-r border-border"
        style={{ background: 'rgba(5,8,16,0.72)', backdropFilter: 'blur(24px)' }}>

        {/* Logo row */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border/60">
          {/* Glowing bolt icon */}
          <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, rgba(0,245,255,0.15), rgba(124,58,237,0.15))',
              border: '1px solid rgba(0,245,255,0.25)',
              boxShadow: '0 0 12px rgba(0,245,255,0.15)'
            }}>
            <LogoBolt />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-display text-sm font-bold tracking-widest text-slate-100 uppercase truncate"
              style={{ textShadow: '0 0 20px rgba(0,245,255,0.3)' }}>
              Deploy Alchemy
            </div>
          </div>
        </div>

        {/* Deployments list */}
        <div className="flex-1 overflow-y-auto py-3 px-2">
          <div className="px-2 mb-2">
            <span className="text-slate-600 font-mono text-xs uppercase tracking-wider">Deployments</span>
          </div>

          {deployments.map(dep => (
            <div
              key={dep.id}
              className={`group relative flex items-center gap-2 mb-1 rounded-xl border transition-all duration-200
                ${dep.id === activeDeployment.id
                  ? 'border-cyan-500/30'
                  : 'border-transparent hover:border-border'}`}
              style={dep.id === activeDeployment.id
                ? { background: 'rgba(0,245,255,0.07)' }
                : {}}
            >
              <button
                onClick={() => { onSwitchDeployment(dep.id); setActiveTab('overview') }}
                className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2.5 text-left"
              >
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-all
                  ${dep.id === activeDeployment.id
                    ? 'bg-cyan-400'
                    : 'bg-slate-600 group-hover:bg-slate-500'}`}
                  style={dep.id === activeDeployment.id
                    ? { boxShadow: '0 0 8px rgba(0,245,255,0.9)' }
                    : {}}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium truncate
                    ${dep.id === activeDeployment.id ? 'text-cyan-300' : 'text-slate-400'}`}>
                    {dep.name}
                  </div>
                  <div className="text-slate-600 font-mono text-xs truncate">
                    {dep.metadata?.eval_metric || '—'}
                  </div>
                </div>
              </button>
              <button
                onClick={e => { e.stopPropagation(); setConfirmDelete(dep.id) }}
                className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center mr-2 opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all duration-150 text-xs"
                title="Remove deployment"
              >✕</button>
            </div>
          ))}

          {/* Add deployment drop zone */}
          <div {...getRootProps()} className="mt-2">
            <input {...getInputProps()} />
            <button className={`w-full py-2 rounded-xl border border-dashed border-border/40 text-slate-600 hover:text-cyan-400 hover:border-cyan-500/30 text-xs font-mono transition-all duration-200 flex items-center justify-center gap-1.5 ${uploading ? 'animate-pulse' : ''}`}>
              <span className="text-sm leading-none">{uploading ? '⟳' : '+'}</span>
              <span>{uploading ? 'Loading...' : 'Add Deployment'}</span>
            </button>
          </div>
        </div>

        {/* ── Bottom footer ──────────────────────────────────────────────── */}
        <div className="border-t border-border/40 px-4 py-3 space-y-2">
          {/* Session notice */}
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-cyan-500/50 flex-shrink-0"
              style={{ boxShadow: '0 0 6px rgba(0,245,255,0.4)' }} />
            <span className="text-slate-600 font-mono text-xs">Session only · No data saved</span>
          </div>

          {/* Divider */}
          <div className="h-px bg-gradient-to-r from-transparent via-border/50 to-transparent" />

          {/* Powered by AutoGluon */}
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded flex-shrink-0 flex items-center justify-center"
              style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.25)' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="#7c3aed"/>
              </svg>
            </div>
            <div>
              <div className="text-slate-600 font-mono text-xs leading-tight"style={{ color: 'rgba(248, 244, 240, 0.95)' }}>Data Alchemy v2.2</div>
              <div className="font-mono text-xs leading-tight" style={{ color: 'rgba(108, 111, 111, 0.83)' }}>
                Powered by AutoGluon
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-void/70 backdrop-blur-sm">
          <div className="glass glow-card rounded-2xl p-6 w-72 border border-border shadow-2xl">
            <h3 className="text-slate-200 font-body font-semibold mb-2">Remove Deployment?</h3>
            <p className="text-slate-500 text-sm mb-5">
              "{deployments.find(d => d.id === confirmDelete)?.name}" will be removed from this session.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 py-2 rounded-lg border border-border text-slate-400 text-sm hover:border-slate-600 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { onRemoveDeployment(confirmDelete); setConfirmDelete(null) }}
                className="flex-1 py-2 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-400 text-sm hover:bg-rose-500/20 transition-colors">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <header className="px-6 py-3 border-b border-border flex-shrink-0"
          style={{ background: 'rgba(8,13,26,0.6)', backdropFilter: 'blur(20px)' }}>
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <h2 className="font-body text-lg font-semibold text-slate-200 truncate">{activeDeployment.name}</h2>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <Badge label={meta?.problem_type || '—'} color="cyan" />
                {meta?.best_model && meta.best_model !== 'Unknown' && (
                  <Badge label={meta.best_model} color="purple" />
                )}
                <span className="text-slate-600 font-mono text-xs">{meta?.num_features_original || 0} features</span>
                {meta?.csv_enriched && (
                  <span className="text-emerald-600 font-mono text-xs flex items-center gap-1">✓ CSV labels loaded</span>
                )}
              </div>
            </div>
          </div>
          {!filesFound.autofeat && (
            <div className="mt-2 flex items-center gap-2 bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-3 py-1.5">
              <span className="text-yellow-500 text-xs">⚠️</span>
              <span className="text-yellow-700 font-mono text-xs">autofeat.pkl not found — raw features used for prediction.</span>
            </div>
          )}
        </header>

        {/* Tabs */}
        <nav className="flex gap-0.5 px-4 pt-3 pb-0 border-b border-border flex-shrink-0 overflow-x-auto"
          style={{ background: 'rgba(5,8,16,0.4)' }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-body font-medium border-b-2 transition-all duration-200 whitespace-nowrap rounded-t-lg
                ${activeTab === tab.id
                  ? 'border-cyan-400 text-cyan-300'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:border-slate-600'}`}
              style={activeTab === tab.id
                ? { background: 'rgba(0,245,255,0.05)' }
                : {}}
            >
              <span className={activeTab === tab.id ? 'text-cyan-400' : 'text-slate-600'}>
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6">
            {activeTab === 'overview'    && <ModelOverview metadata={meta} />}
            {activeTab === 'leaderboard' && <Leaderboard metadata={meta} />}
            {activeTab === 'analytics'   && <Analytics metadata={meta} />}
            {activeTab === 'predict'     && <PredictionForm deployment={activeDeployment} onMetaUpdate={(m) => onUpdateDeployment(activeDeployment.id, { metadata: m })} />}
            {activeTab === 'batch'       && <BatchPrediction deployment={activeDeployment} />}
            {activeTab === 'whatif'      && <WhatIfBuilder deployment={activeDeployment} />}
            {activeTab === 'export'      && <ExportPanel deployment={activeDeployment} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Badge({ label, color }) {
  const colors = {
    cyan:   'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  }
  return <span className={`border rounded px-2 py-0.5 font-mono text-xs ${colors[color]}`}>{label}</span>
}
