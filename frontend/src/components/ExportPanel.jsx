import { useState, useCallback } from 'react'
import axios from 'axios'
import toast from 'react-hot-toast'
import { SectionHeader } from './ModelOverview'

export default function ExportPanel({ deployment }) {
  const [downloading, setDownloading] = useState(false)
  const meta = deployment?.metadata || {}

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await axios.get(`/api/session/${deployment.sessionId}/export`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const name = deployment.name.replace(/\s+/g, '_').toLowerCase()
      Object.assign(document.createElement('a'), { href: url, download: `${name}_deployment.zip` }).click()
      URL.revokeObjectURL(url)
      toast.success('Deployment package ready!')
    } catch {
      toast.error('Export failed')
    } finally { setDownloading(false) }
  }

  return (
    <div className="space-y-6">

      {/* What's inside */}
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="📦" title="Deployment Package" subtitle="Everything needed to run your model — download & go live" />

        {/* Key difference callout */}
        <div className="mt-4 flex items-start gap-3 bg-cyan-500/5 border border-cyan-500/20 rounded-xl px-4 py-3">
          <span className="text-cyan-400 text-lg flex-shrink-0">⚡</span>
          <div>
            <p className="text-cyan-300 font-body text-sm font-semibold mb-1">Model files are bundled inside</p>
            <p className="text-cyan-700 font-mono text-xs leading-relaxed">
              The ZIP contains your actual AutoGluon model, autofeat pipeline, and feature schema.
              Just download → <code className="text-cyan-400">pip install -r requirements.txt</code> → run. No extra steps.
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { file: 'app.py',              desc: 'FastAPI server — serves the UI + API',                     icon: '🐍' },
            { file: 'frontend/index.html', desc: 'Standalone prediction UI (Welcome + Predict + Batch)',     icon: '🌐' },
            { file: 'schema.json',         desc: 'Model metadata, feature schema, leaderboard',             icon: '🧬' },
            { file: 'autogluon_model/',    desc: 'Your trained AutoGluon model (bundled from upload)',       icon: '🧠' },
            { file: 'autofeat_model.pkl',  desc: 'Feature engineering pipeline (if used)',                  icon: '⚗️' },
            { file: 'features_eng.json',   desc: 'Engineered feature definitions (if used)',                 icon: '🔧' },
            { file: 'requirements.txt',    desc: 'Auto-generated Python dependencies',                      icon: '📋' },
            { file: 'Dockerfile',          desc: 'Container — runs anywhere with Docker',                   icon: '🐳' },
            { file: 'docker-compose.yml',  desc: 'Local dev setup — single command',                       icon: '🔧' },
            { file: 'render.yaml',         desc: 'One-click Render.com deployment',                         icon: '🌐' },
            { file: 'fly.toml',            desc: 'Fly.io — global edge deployment',                         icon: '✈️' },
            { file: 'railway.json',        desc: 'Railway — push and auto-deploy',                          icon: '🚂' },
            { file: 'openapi.json',        desc: 'Full API spec (Swagger compatible)',                      icon: '📘' },
            { file: 'README.md',           desc: 'Step-by-step run & deploy guide',                         icon: '📖' },
          ].map(item => (
            <div key={item.file} className="flex items-start gap-3 bg-surface/60 rounded-lg p-3">
              <span className="text-base flex-shrink-0">{item.icon}</span>
              <div>
                <div className="font-mono text-xs text-cyan-300">{item.file}</div>
                <div className="text-slate-500 text-xs mt-0.5">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <button onClick={handleDownload} disabled={downloading}
          className={`mt-6 w-full py-4 rounded-xl font-body font-bold text-base transition-all duration-300
            ${downloading
              ? 'bg-surface border border-border text-slate-600 cursor-wait'
              : 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/40 text-cyan-300 hover:from-cyan-500/30 hover:to-purple-500/30 hover:shadow-[0_0_40px_rgba(0,245,255,0.2)] active:scale-[0.99]'}`}>
          {downloading
            ? <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                Bundling model files...
              </span>
            : '⬇️ Download Full Deployment Package'}
        </button>
      </div>

      {/* Quick start steps */}
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="⚡" title="Quick Start — Run Locally" subtitle="3 commands to go live" />
        <div className="mt-4 space-y-3">
          {[
            { step:'01', cmd:'pip install -r requirements.txt', detail:'Install Python dependencies (~2-3 min first time)' },
            { step:'02', cmd:'uvicorn app:app --host 0.0.0.0 --port 8000', detail:'Start the prediction server' },
            { step:'03', cmd:'http://localhost:8000', detail:'Open browser — Welcome screen + full prediction UI ready' },
          ].map(item => (
            <div key={item.step} className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                <span className="text-cyan-500 font-mono text-xs font-bold">{item.step}</span>
              </div>
              <div className="flex-1 min-w-0">
                <CopyableCmd cmd={item.cmd} />
                <div className="text-slate-600 text-xs mt-1">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Docker alternative */}
        <div className="mt-5 border-t border-border pt-4">
          <div className="text-slate-600 font-mono text-xs uppercase tracking-wider mb-3">Or with Docker</div>
          <div className="bg-void/80 rounded-lg p-3 font-mono text-xs border border-border/40 space-y-2">
            <div className="text-slate-600"># build</div>
            <CopyableCmd cmd={`docker build -t ${deployment.name.toLowerCase().replace(/\s+/g,'_')} .`} dark />
            <div className="text-slate-600 mt-1"># run</div>
            <CopyableCmd cmd={`docker run -p 8000:8000 ${deployment.name.toLowerCase().replace(/\s+/g,'_')}`} dark />
          </div>
        </div>
      </div>

      {/* Deploy targets */}
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="🚀" title="Deploy to Cloud" subtitle="All configs included in the package" />
        <div className="mt-4 space-y-3">
          {[
            { name:'Railway', icon:'🚂', badge:'Recommended', color:'cyan',   desc:'Push to GitHub → import repo → auto-deploy. Configs included.',       cmd:'railway up' },
            { name:'Render',  icon:'🌐', badge:'Free Tier',   color:'jade',   desc:'Use render.yaml for one-click deploy. Free tier available.',             cmd:'via dashboard' },
            { name:'Fly.io',  icon:'✈️', badge:'Fast',        color:'purple', desc:'Global edge deployment. Fly.toml included.',                            cmd:'flyctl deploy' },
            { name:'Docker',  icon:'🐳', badge:'Universal',   color:'ember',  desc:'Self-host anywhere. docker-compose.yml included.',                       cmd:'docker compose up' },
          ].map(t => (
            <div key={t.name} className="flex items-start gap-4 bg-surface/60 rounded-xl p-4 border border-border/40">
              <span className="text-2xl flex-shrink-0">{t.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-body font-semibold text-slate-200 text-sm">{t.name}</span>
                  <BadgePill label={t.badge} color={t.color} />
                </div>
                <p className="text-slate-500 text-xs">{t.desc}</p>
              </div>
              <code className="text-slate-600 font-mono text-xs flex-shrink-0 hidden md:block">{t.cmd}</code>
            </div>
          ))}
        </div>
      </div>

      {/* API ref */}
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="📘" title="API Reference" subtitle="Endpoints exposed by your deployment" />
        <div className="mt-4 space-y-2 font-mono text-xs">
          {[
            { method:'GET',  path:'/',              desc:'Prediction UI (browser)',    color:'text-emerald-400' },
            { method:'GET',  path:'/health',        desc:'Liveness check',             color:'text-emerald-400' },
            { method:'GET',  path:'/model-info',    desc:'Model metadata + schema',    color:'text-emerald-400' },
            { method:'POST', path:'/predict',       desc:'Single prediction',          color:'text-cyan-400' },
            { method:'POST', path:'/predict-batch', desc:'Batch CSV prediction',       color:'text-cyan-400' },
          ].map(ep => (
            <div key={ep.path} className="flex items-center gap-3 bg-surface/60 rounded-lg px-3 py-2.5">
              <span className={`text-xs font-bold w-10 ${ep.color}`}>{ep.method}</span>
              <span className="text-slate-300 flex-1">{ep.path}</span>
              <span className="text-slate-600">{ep.desc}</span>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <div className="text-slate-600 font-mono text-xs mb-2">Sample curl:</div>
          <CopyableCmd cmd={`curl -X POST http://localhost:8000/predict -H "Content-Type: application/json" -d '{"inputs": {${(meta.input_schema||[]).slice(0,2).map(f=>`"${f.name}": ...`).join(', ')}}}'`} />
        </div>
      </div>
    </div>
  )
}

function BadgePill({ label, color }) {
  const colors = {
    cyan:   'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    jade:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    ember:  'bg-orange-500/10 text-orange-400 border-orange-500/20',
  }
  return <span className={`border rounded px-1.5 py-0.5 text-xs font-mono ${colors[color]||colors.cyan}`}>{label}</span>
}

function CopyableCmd({ cmd, dark = false }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      // fallback for older browsers
      const ta = document.createElement('textarea')
      ta.value = cmd; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }, [cmd])
  return (
    <div className={`group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-all duration-200 ${dark ? 'bg-transparent' : 'bg-surface/80 hover:bg-surface'}`}
      onClick={copy} title="Click to copy">
      <span className="font-mono text-xs text-cyan-300 flex-1 select-all">{cmd}</span>
      <span className={`flex-shrink-0 font-mono text-xs transition-all duration-200 ${copied ? 'text-emerald-400' : 'text-slate-600 group-hover:text-slate-400'}`}>
        {copied ? '✓ copied' : '⎘ copy'}
      </span>
    </div>
  )
}
