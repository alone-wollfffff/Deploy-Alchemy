import { useState, useEffect } from 'react'

const SCAN_STEPS = [
  { id: 'zip',        label: 'Extracting ZIP contents',               delay: 400  },
  { id: 'autogluon',  label: 'Locating AutoGluon model artifacts',    delay: 900  },
  { id: 'training',   label: 'Reading training feature data',         delay: 1500 },
  { id: 'autofeat',   label: 'Checking feature engineering pipeline', delay: 2100 },
  { id: 'leaderboard',label: 'Parsing model leaderboard',             delay: 2700 },
  { id: 'schema',     label: 'Building smart input schema',           delay: 3300 },
  { id: 'ready',      label: 'Your model is ready to speak',          delay: 4000 },
]

export default function ScanAnimation({ metadata, filesFound, onComplete }) {
  const [completed, setCompleted] = useState([])
  const [current, setCurrent] = useState(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    SCAN_STEPS.forEach(step => {
      setTimeout(() => {
        setCurrent(step.id)
        setCompleted(prev => [...prev, step.id])
        if (step.id === 'ready') {
          setTimeout(() => setDone(true), 800)
        }
      }, step.delay)
    })
  }, [])

  useEffect(() => {
    if (done) setTimeout(() => onComplete(), 600)
  }, [done, onComplete])

  const meta = metadata || {}

  return (
    <div className="relative z-10 flex flex-col items-center justify-center min-h-screen px-4">
      <div className="scan-line" />
      <div className="w-full max-w-xl">

        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-4 py-1.5 mb-4">
            <PulsingDot />
            <span className="text-cyan-400 font-mono text-xs tracking-widest uppercase">Transmutation in progress</span>
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold text-slate-200 tracking-wide">Reading Your Model</h2>
        </div>

        {/* Steps */}
        <div className="glass rounded-2xl p-6 mb-6 space-y-0">
          {SCAN_STEPS.map((step, i) => {
            const isComplete = completed.includes(step.id)
            const isCurrent = current === step.id && step.id !== 'ready'
            const isReady = step.id === 'ready' && isComplete

            // For autofeat step — show warning state if not found
            const isAutofeatMissing = step.id === 'autofeat' && isComplete && filesFound && !filesFound.autofeat

            return (
              <div
                key={step.id}
                className={`flex items-center gap-4 py-3 transition-all duration-500
                  ${i < SCAN_STEPS.length - 1 ? 'border-b border-border/40' : ''}
                  ${isComplete ? 'opacity-100' : 'opacity-20'}`}
                style={{ animation: isComplete ? 'scan 0.4s ease-out forwards' : 'none' }}
              >
                <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
                  {isReady ? (
                    <span className="text-lg">🎉</span>
                  ) : isAutofeatMissing ? (
                    <span className="text-yellow-400 text-sm">⚠️</span>
                  ) : isComplete ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" stroke="#00f5ff" strokeWidth="1"/>
                      <polyline points="4,8 7,11 12,5" stroke="#00f5ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  ) : (
                    <div className="w-3 h-3 rounded-full border border-border"/>
                  )}
                </div>

                <span className={`font-body text-sm flex-1
                  ${isReady ? 'text-cyan-300 font-semibold text-base'
                    : isAutofeatMissing ? 'text-yellow-400'
                    : isComplete ? 'text-slate-300'
                    : 'text-slate-600'}`}>
                  {step.label}
                  {isAutofeatMissing && ' — not found (optional)'}
                </span>

                {isCurrent && (
                  <div className="flex gap-1">
                    {[0,1,2].map(d => (
                      <div key={d} className="w-1 h-1 rounded-full bg-cyan-400 animate-bounce"
                        style={{ animationDelay: `${d * 0.15}s` }}/>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Model preview card */}
        {completed.includes('ready') && (
          <div className="glass rounded-2xl p-5 border border-cyan-500/20 shadow-[0_0_30px_rgba(0,245,255,0.1)]"
            style={{ animation: 'scan 0.5s ease-out forwards' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                <span className="text-sm">🧠</span>
              </div>
              <span className="text-slate-400 font-mono text-xs uppercase tracking-wider">Model Intelligence</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatPill label="Best Model" value={meta.best_model || '—'} />
              <StatPill label="Task Type" value={meta.problem_type || '—'} accent="purple"/>
              <StatPill label="Eval Metric" value={meta.eval_metric || '—'} accent="ember"/>
              <StatPill label="Features" value={`${meta.num_features_original || 0} input`} accent="jade"/>
            </div>

            {/* Notification banners */}
            {filesFound && !filesFound.autofeat && (
              <div className="mt-4 flex items-start gap-2 bg-yellow-500/8 border border-yellow-500/20 rounded-lg px-3 py-2.5">
                <span className="text-yellow-400 flex-shrink-0">⚠️</span>
                <div>
                  <p className="text-yellow-300 text-xs font-medium">autofeat.pkl not found</p>
                  <p className="text-yellow-600 text-xs mt-0.5">Feature engineering was not used in Data Alchemy. Predictions will use raw input features only.</p>
                </div>
              </div>
            )}
            {filesFound && !filesFound.features_json && (
              <div className="mt-2 flex items-start gap-2 bg-orange-500/8 border border-orange-500/20 rounded-lg px-3 py-2.5">
                <span className="text-orange-400 flex-shrink-0">⚠️</span>
                <div>
                  <p className="text-orange-300 text-xs font-medium">features_eng.json not found</p>
                  <p className="text-orange-600 text-xs mt-0.5">Feature schema was read directly from the AutoGluon model instead.</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PulsingDot() {
  return (
    <div className="relative w-2 h-2">
      <div className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-75"/>
      <div className="relative rounded-full bg-cyan-400 w-2 h-2"/>
    </div>
  )
}

function StatPill({ label, value, accent = 'cyan' }) {
  const colors = { cyan: 'text-cyan-300', purple: 'text-purple-300', ember: 'text-orange-300', jade: 'text-emerald-300' }
  return (
    <div className="bg-surface/80 rounded-lg px-3 py-2">
      <div className="text-slate-600 font-mono text-xs mb-1">{label}</div>
      <div className={`font-body text-sm font-medium truncate ${colors[accent]}`}>{value}</div>
    </div>
  )
}
