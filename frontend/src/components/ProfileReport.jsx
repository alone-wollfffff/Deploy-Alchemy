import { useState, useEffect } from 'react'
import axios from 'axios'

export default function ProfileReport({ deployment }) {
  const [htmlContent, setHtmlContent] = useState(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)
  const [blobUrl, setBlobUrl]         = useState(null)

  useEffect(() => {
    let objectUrl = null
    const fetchReport = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await axios.get(
          `/api/session/${deployment.sessionId}/profile-report`,
          { responseType: 'text' }
        )
        const blob = new Blob([res.data], { type: 'text/html' })
        objectUrl = URL.createObjectURL(blob)
        setBlobUrl(objectUrl)
        setHtmlContent(res.data)
      } catch (err) {
        setError(
          err.response?.status === 404
            ? 'No profile report found in this ZIP.\nMake sure your Data Alchemy ZIP contains a profile_report.html file.'
            : `Failed to load profile report: ${err.message}`
        )
      } finally {
        setLoading(false)
      }
    }
    fetchReport()
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [deployment.sessionId])

  const handleOpenNew = () => {
    if (blobUrl) window.open(blobUrl, '_blank', 'noopener')
  }

  if (loading) {
    return (
      <div className="glass glow-card rounded-xl p-12 flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
        <p className="text-slate-500 font-mono text-sm">Loading profile report...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="glass glow-card rounded-xl p-10 flex flex-col items-center justify-center gap-4 border border-yellow-500/20">
        <span className="text-4xl opacity-40">📊</span>
        <div className="text-center">
          <p className="text-yellow-400 font-body text-base font-medium mb-2">Profile Report Not Available</p>
          <p className="text-slate-500 font-mono text-xs whitespace-pre-line leading-relaxed">{error}</p>
        </div>
        <div className="mt-2 bg-surface/60 border border-border rounded-xl px-5 py-4 text-xs font-mono text-slate-500 max-w-md">
          <p className="text-slate-400 mb-1 font-semibold">Expected ZIP structure:</p>
          <pre className="text-emerald-700 leading-relaxed">{`your_model.zip
├── autogluon_model/
├── autofeat_model.pkl
├── feature_engineering.json
├── processed_data.csv      ← CSV auto-loaded
└── profile_report.html     ← EDA report`}</pre>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 font-mono text-xs uppercase tracking-wider">📊 EDA Profile Report</span>
          <span className="text-emerald-600 font-mono text-xs border border-emerald-500/20 bg-emerald-500/5 rounded px-2 py-0.5">
            ✓ Loaded from ZIP
          </span>
        </div>
        {blobUrl && (
          <button
            onClick={handleOpenNew}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/8 text-cyan-400 font-mono text-xs hover:bg-cyan-500/15 transition-colors"
          >
            ↗ Open in New Tab
          </button>
        )}
      </div>

      {/* Report iframe */}
      <div
        className="rounded-xl overflow-hidden border border-border"
        style={{ height: 'calc(100vh - 220px)', minHeight: 500 }}
      >
        {blobUrl && (
          <iframe
            src={blobUrl}
            title="Data Profile Report"
            className="w-full h-full"
            style={{ border: 'none', background: '#ffffff' }}
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        )}
      </div>
    </div>
  )
}
