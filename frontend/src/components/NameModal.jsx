import { useState, useEffect, useRef } from 'react'

export default function NameModal({ defaultName, onConfirm }) {
  const [name, setName] = useState(defaultName || '')
  const inputRef = useRef(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [])

  const handleSubmit = () => {
    onConfirm(name.trim() || defaultName)
  }

  return (
    <div className="relative z-10 flex items-center justify-center min-h-screen px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative glass rounded-2xl p-8 w-full max-w-md border border-cyan-500/20 shadow-[0_0_60px_rgba(0,245,255,0.1)]"
        style={{ animation: 'scan 0.4s ease-out forwards' }}
      >
        {/* Icon */}
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-cyan-500/20 to-purple-500/20 border border-cyan-500/30 flex items-center justify-center">
            <span className="text-2xl">⚗️</span>
          </div>
        </div>

        <h2 className="font-display text-xl font-bold text-slate-200 text-center mb-2 tracking-wide">
          Name Your Deployment
        </h2>
        <p className="text-slate-500 font-body text-sm text-center mb-6">
          Give this model a name you'll recognise
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-slate-500 font-mono text-xs uppercase tracking-wider block mb-2">
              Deployment Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder={defaultName}
              className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-slate-200 font-body text-sm outline-none focus:border-cyan-500/50 transition-colors"
            />
            <p className="text-slate-700 font-mono text-xs mt-1.5">
              Leave empty to use: <span className="text-slate-500">{defaultName}</span>
            </p>
          </div>

          <button
            onClick={handleSubmit}
            className="w-full py-3.5 rounded-xl font-body font-semibold text-base
              bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/40
              text-cyan-300 hover:from-cyan-500/30 hover:to-purple-500/30
              hover:shadow-[0_0_30px_rgba(0,245,255,0.2)] transition-all duration-300"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  )
}
