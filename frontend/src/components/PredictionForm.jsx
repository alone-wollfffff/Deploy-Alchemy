import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import toast from 'react-hot-toast'
import { SectionHeader } from './ModelOverview'

function showFieldError(msg) {
  toast.error(msg, {
    duration: 10000,
    style: {
      maxWidth: '520px', whiteSpace: 'pre-line',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', lineHeight: '1.6',
      background: 'rgba(17,10,20,0.97)',
      border: '1px solid rgba(244,63,94,0.4)', color: '#f87171',
    }
  })
}
function showWarnToast(msg) {
  toast(msg, { icon: '⚠️', duration: 8000, style: { maxWidth: '480px', whiteSpace: 'pre-line', background: 'rgba(17,29,53,0.97)', color: '#fcd34d', border: '1px solid rgba(245,158,11,0.35)', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' } })
}

export default function PredictionForm({ deployment, onMetaUpdate }) {
  const [inputs, setInputs] = useState({})
  const [predicting, setPredicting] = useState(false)
  const [result, setResult] = useState(null)
  const [errors, setErrors] = useState({})
  const [warnings, setWarnings] = useState({})
  const [autoFilled, setAutoFilled] = useState([])
  const [selectedModel, setSelectedModel] = useState(null)
  const [enriching, setEnriching] = useState(false)
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`history_${deployment.id}`) || '[]') }
    catch { return [] }
  })

  const schema = deployment?.metadata?.input_schema || []
  const meta = deployment?.metadata
  const models = meta?.model_names || []
  const csvEnriched = meta?.csv_enriched || false
  const hasEncodedDropdowns = schema.some(f => f.widget === 'encoded_dropdown')

  // CSV upload for label enrichment (only shown if NOT already auto-enriched from ZIP)
  const onCsvDrop = useCallback(async (files) => {
    const f = files[0]
    if (!f) return
    setEnriching(true)
    const formData = new FormData()
    formData.append('file', f)
    try {
      const res = await axios.post(`/api/session/${deployment.sessionId}/enrich-csv`, formData)
      const data = res.data
      toast.success(`Labels loaded! ${data.enriched_columns.length} columns enriched: ${data.enriched_columns.slice(0,3).join(', ')}`)
      if (data.updated_schema && onMetaUpdate) {
        onMetaUpdate({ ...meta, input_schema: data.updated_schema, csv_enriched: true })
      }
    } catch (err) {
      const msg = err.response?.data?.detail || 'CSV enrichment failed'
      showFieldError(msg)
    } finally {
      setEnriching(false)
    }
  }, [deployment.sessionId, meta, onMetaUpdate])

  const { getRootProps: getCsvRootProps, getInputProps: getCsvInputProps } = useDropzone({
    onDrop: onCsvDrop,
    accept: { 'text/csv': ['.csv'] },
    multiple: false,
  })

  const validateField = (field, value) => {
    const newErrors = { ...errors }
    const newWarnings = { ...warnings }
    if (!value && value !== 0) {
      delete newErrors[field.name]; delete newWarnings[field.name]; return
    }
    if ((field.dtype.includes('int') || field.dtype.includes('float')) && isNaN(parseFloat(value))) {
      newErrors[field.name] = 'Expected a number'
      delete newWarnings[field.name]
    } else {
      delete newErrors[field.name]
      const num = parseFloat(value)
      if (!isNaN(num)) {
        const min = field.min != null ? parseFloat(field.min) : null
        const max = field.max != null ? parseFloat(field.max) : null
        if ((min != null && num < min * 0.5) || (max != null && num > max * 2)) {
          newWarnings[field.name] = `Outside training range (${min ?? '?'} – ${max ?? '?'})`
        } else {
          delete newWarnings[field.name]
        }
      }
    }
    setErrors(newErrors)
    setWarnings(newWarnings)
  }

  const setInput = (name, value) => {
    setInputs(prev => ({ ...prev, [name]: value }))
    const field = schema.find(f => f.name === name)
    if (field) validateField(field, value)
  }

  const completenessCount = schema.filter(f => inputs[f.name] !== undefined && inputs[f.name] !== '').length
  const completeness = schema.length > 0 ? Math.round((completenessCount / schema.length) * 100) : 0
  const hasErrors = Object.keys(errors).length > 0
  const hasWarnings = Object.keys(warnings).length > 0

  const handlePredict = async () => {
    if (hasErrors) { toast.error('Fix validation errors first'); return }
    setPredicting(true); setResult(null)
    try {
      const res = await axios.post(`/api/session/${deployment.sessionId}/predict`, {
        inputs, model_name: selectedModel || null,
      })
      const data = res.data
      setResult(data)
      setAutoFilled(data.auto_filled || [])
      const entry = { id: Date.now(), inputs: { ...inputs }, result: data, time: new Date().toLocaleTimeString() }
      const newHistory = [entry, ...history].slice(0, 20)
      setHistory(newHistory)
      try { localStorage.setItem(`history_${deployment.id}`, JSON.stringify(newHistory)) } catch (_) {}
    } catch (err) {
      showFieldError(err.response?.data?.detail || 'Prediction failed')
    } finally {
      setPredicting(false)
    }
  }

  if (!schema.length) {
    return (
      <div className="glass glow-card rounded-xl p-8 text-center text-slate-500">
        <div className="text-3xl mb-3">🔮</div>
        <p>No feature schema available</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">

      {/* CSV labels status banner */}
      {hasEncodedDropdowns && csvEnriched && (
        <div className="glass rounded-xl p-3 border border-emerald-500/20 flex items-center gap-3">
          <span className="text-emerald-400 text-base flex-shrink-0">✅</span>
          <div>
            <p className="text-emerald-300 font-body text-sm font-medium">CSV labels auto-loaded from ZIP</p>
            <p className="text-emerald-700 font-mono text-xs">Dropdowns show real category names from your training data</p>
          </div>
        </div>
      )}

      {/* Manual CSV upload — only show if encoded dropdowns exist and NOT yet enriched */}
      {hasEncodedDropdowns && !csvEnriched && (
        <div className="glass glow-card rounded-xl p-4 border border-yellow-500/20">
          <div className="flex items-start gap-3">
            <span className="text-xl flex-shrink-0">🏷️</span>
            <div className="flex-1 min-w-0">
              <p className="text-yellow-300 font-body text-sm font-medium mb-1">
                Some fields show numeric codes instead of labels
              </p>
              <p className="text-yellow-700 font-mono text-xs mb-3">
                Upload your original training CSV to replace 0, 1, 2... with real labels.
                (Tip: use the new ZIP format from Data Alchemy — it includes the CSV automatically!)
              </p>
              <div {...getCsvRootProps()} className="cursor-pointer">
                <input {...getCsvInputProps()} />
                <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-yellow-500/30 hover:border-yellow-500/50 hover:bg-yellow-500/5 transition-all duration-200 ${enriching ? 'animate-pulse' : ''}`}>
                  {enriching ? (
                    <span className="text-yellow-400 text-xs font-mono">⟳ Loading labels...</span>
                  ) : (
                    <>
                      <span className="text-yellow-500 text-sm">📄</span>
                      <span className="text-yellow-600 font-mono text-xs">Drop original CSV here to load real labels (optional)</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2">
          <div className="glass glow-card rounded-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <SectionHeader icon="🎛️" title="Prediction Inputs" subtitle={`${schema.length} features`} />
              <div className="flex items-center gap-3">
                {models.length > 1 && (
                  <select
                    value={selectedModel || ''}
                    onChange={e => setSelectedModel(e.target.value || null)}
                    className="bg-surface border border-border text-slate-400 font-mono text-xs rounded-lg px-2 py-1.5"
                  >
                    <option value="">Best Model</option>
                    {models.map(m => <option key={m} value={m}>{m.slice(0, 22)}</option>)}
                  </select>
                )}
                <button onClick={() => { setInputs({}); setResult(null); setErrors({}); setWarnings({}); setAutoFilled([]) }}
                  className="text-slate-600 hover:text-slate-400 font-mono text-xs transition-colors">
                  Reset
                </button>
              </div>
            </div>

            {/* Completeness bar */}
            <div className="mb-5">
              <div className="flex justify-between mb-1.5">
                <span className="text-slate-600 font-mono text-xs">Form completeness</span>
                <span className="text-slate-500 font-mono text-xs">{completenessCount}/{schema.length}</span>
              </div>
              <div className="w-full bg-border rounded-full h-1.5">
                <div className="h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${completeness}%`, background: completeness === 100 ? 'linear-gradient(90deg,#10b981,#00f5ff)' : 'linear-gradient(90deg,#7c3aed,#00f5ff)' }} />
              </div>
            </div>

            {/* Fields grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {schema.map(field => (
                <FieldInput
                  key={field.name}
                  field={field}
                  value={inputs[field.name] ?? ''}
                  onChange={(v) => setInput(field.name, v)}
                  error={errors[field.name]}
                  warning={warnings[field.name]}
                  autoFilled={autoFilled.includes(field.name)}
                />
              ))}
            </div>

            {/* Cast button */}
            <div className="mt-6">
              {hasWarnings && !hasErrors && (
                <p className="text-yellow-500/70 font-mono text-xs mb-3 flex items-center gap-1">
                  <span>⚠️</span>
                  <span>{Object.keys(warnings).length} field(s) outside training range</span>
                </p>
              )}
              <button
                onClick={handlePredict}
                disabled={predicting || hasErrors}
                className={`w-full py-3.5 rounded-xl font-body font-semibold text-base transition-all duration-300
                  ${hasErrors ? 'bg-surface border border-border text-slate-600 cursor-not-allowed'
                    : predicting ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 cursor-wait'
                    : 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/40 text-cyan-300 hover:from-cyan-500/30 hover:to-purple-500/30 hover:shadow-[0_0_30px_rgba(0,245,255,0.2)] active:scale-[0.99]'}`}
              >
                {predicting
                  ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin"/>Casting Prediction...</span>
                  : '🔮 Cast Prediction'}
              </button>
            </div>
          </div>
        </div>

        {/* Result + History */}
        <div className="space-y-4">
          {result
            ? <PredictionResult result={result} meta={meta} />
            : <div className="glass glow-card rounded-xl p-6 text-center border border-dashed border-border">
                <div className="text-3xl mb-3 opacity-30">🔮</div>
                <p className="text-slate-600 text-sm">Fill the form and cast a prediction</p>
              </div>
          }

          {history.length > 0 && (
            <div className="glass glow-card rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-slate-500 font-mono text-xs uppercase tracking-wider">History</span>
                <button onClick={() => { setHistory([]); try { localStorage.removeItem(`history_${deployment.id}`) } catch (_) {} }}
                  className="text-slate-700 hover:text-slate-500 font-mono text-xs">Clear</button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {history.map(entry => (
                  <button key={entry.id} onClick={() => { setInputs(entry.inputs); setResult(entry.result) }}
                    className="w-full text-left bg-surface/60 rounded-lg px-3 py-2 hover:bg-card transition-colors">
                    <div className="flex justify-between">
                      <span className="text-cyan-400 font-mono text-xs font-bold">→ {String(entry.result?.prediction)}</span>
                      <span className="text-slate-700 font-mono text-xs">{entry.time}</span>
                    </div>
                    {entry.result?.probabilities && (() => {
                      const vals = Object.values(entry.result.probabilities).filter(v => isFinite(v))
                      const conf = vals.length ? Math.round(Math.max(...vals) * 100) : null
                      return conf != null && conf > 0 ? (
                        <div className="text-slate-600 font-mono text-xs mt-0.5">
                          {conf}% confidence
                      </div>
                      ) : null
                    })()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FieldInput({ field, value, onChange, error, warning, autoFilled }) {
  const borderClass = error
    ? 'border-rose-500/50 focus:border-rose-400'
    : warning
    ? 'border-yellow-500/30 focus:border-yellow-400'
    : 'border-border focus:border-cyan-500/50'

  const baseInput = `w-full bg-surface rounded-lg px-3 py-2 text-sm font-body text-slate-200 border ${borderClass} outline-none transition-colors duration-200 placeholder-slate-700`

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-slate-400 font-mono text-xs">
        <span className="truncate">{field.name}</span>
        {autoFilled && <span className="text-cyan-600 text-xs">🤖 auto</span>}
      </label>

      {field.widget === 'toggle' ? (
        <label className="toggle-switch">
          <input type="checkbox"
            checked={value === true || value === '1' || value === 1}
            onChange={e => onChange(e.target.checked ? 1 : 0)} />
          <span className="toggle-track" />
          <span className="ml-2 text-slate-400 font-mono text-xs">
            {value === true || value === '1' || value === 1 ? 'Yes (1)' : 'No (0)'}
          </span>
        </label>

      ) : field.widget === 'dropdown' ? (
        <select value={value} onChange={e => onChange(e.target.value)}
          className={baseInput} style={{ background: '#0d1628' }}>
          <option value="">Select...</option>
          {(field.options || []).map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
        </select>

      ) : field.widget === 'labeled_dropdown' ? (
        // Real labels from CSV
        <select value={value} onChange={e => onChange(e.target.value)}
          className={baseInput} style={{ background: '#0d1628' }}>
          <option value="">Select...</option>
          {(field.options || []).map((opt, i) => (
            <option key={i} value={opt.value}>{opt.label}</option>
          ))}
        </select>

      ) : field.widget === 'encoded_dropdown' ? (
        // Numeric encoded — CSV enrichment would upgrade these to labeled_dropdown
        <div className="space-y-1">
          <select value={value} onChange={e => onChange(e.target.value)}
            className={baseInput} style={{ background: '#0d1628' }}>
            <option value="">Select value...</option>
            {(field.options || []).map((opt, i) => (
              <option key={i} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

      ) : (
        <input type="number" value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.median != null ? `median: ${typeof field.median === 'number' ? field.median.toFixed(2) : field.median}` : 'Enter value...'}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          step="any"
          className={baseInput} />
      )}

      {error && <p className="text-rose-400 font-mono text-xs">❌ {error}</p>}
      {warning && !error && <p className="text-yellow-500/70 font-mono text-xs">⚠️ {warning}</p>}
    </div>
  )
}

function PredictionResult({ result, meta }) {
  const { prediction, probabilities, auto_filled } = result
  const isClassification = ['binary', 'multiclass'].includes(meta?.problem_type)

  // Guard: only compute confidence if we have valid finite probabilities
  const probValues = probabilities ? Object.values(probabilities).filter(v => typeof v === 'number' && isFinite(v)) : []
  const maxProb = probValues.length > 0 ? Math.max(...probValues) : null
  // Clamp to 0-100, guard against NaN / Infinity
  const rawConf = maxProb != null ? maxProb * 100 : null
  const confidence = rawConf != null && isFinite(rawConf) ? Math.round(Math.max(0, Math.min(100, rawConf))) : null

  const getColor = () => {
    if (!isClassification) return '#00f5ff'
    const p = parseFloat(prediction)
    if (!isNaN(p)) return p === 0 ? '#10b981' : p === 1 ? '#f43f5e' : '#00f5ff'
    return '#00f5ff'
  }
  const color = getColor()

  // Format prediction value nicely
  const displayPrediction = (() => {
    const n = parseFloat(prediction)
    if (!isNaN(n) && !isClassification) {
      // regression — format with commas, up to 2 decimals
      return n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    }
    return String(prediction)
  })()

  return (
    <div className="glass glow-card rounded-xl p-5 result-entrance border" style={{ borderColor: `${color}30` }}>
      <SectionHeader icon="🎯" title="Prediction" subtitle="Model output" />

      <div className="mt-4 text-center py-6 rounded-xl" style={{ background: `${color}08` }}>
        <div className="font-display font-bold mb-2 break-all px-2"
          style={{ color, textShadow: `0 0 30px ${color}50`,
            fontSize: displayPrediction.length > 12 ? '1.8rem' : displayPrediction.length > 8 ? '2.2rem' : '2.8rem' }}>
          {displayPrediction}
        </div>
        {confidence != null
          ? <div className="text-slate-400 font-mono text-sm">{confidence}% confidence</div>
          : !isClassification && <div className="text-slate-600 font-mono text-xs">regression output</div>
        }
      </div>

      {confidence != null && (
        <div className="mt-4"><ConfidenceGauge value={confidence} color={color} /></div>
      )}

      {probabilities && Object.keys(probabilities).length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-slate-600 font-mono text-xs uppercase tracking-wider mb-2">Class Probabilities</div>
          {Object.entries(probabilities).sort((a,b) => b[1]-a[1]).map(([cls, prob]) => (
            <div key={cls} className="flex items-center gap-2">
              <span className="text-slate-500 font-mono text-xs w-14 truncate">{cls}</span>
              <div className="flex-1 bg-border rounded-full h-1.5">
                <div className="h-1.5 rounded-full transition-all duration-700"
                  style={{ width: `${prob * 100}%`, background: prob === maxProb ? `linear-gradient(90deg,${color}80,${color})` : 'rgba(100,116,139,0.4)' }} />
              </div>
              <span className="text-slate-500 font-mono text-xs w-10 text-right">{(prob * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}

      {auto_filled?.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-slate-600 font-mono text-xs">🤖 {auto_filled.length} field(s) auto-filled with training medians</p>
        </div>
      )}
    </div>
  )
}

function ConfidenceGauge({ value, color }) {
  // Ensure value is a valid 0-100 number
  const safeVal = (typeof value === 'number' && isFinite(value)) ? Math.max(0, Math.min(100, value)) : 0
  const r = 36, c = 2 * Math.PI * r
  const fill = c - (safeVal / 100) * c
  const qualityLabel = safeVal >= 90 ? 'excellent' : safeVal >= 75 ? 'good' : safeVal >= 60 ? 'fair' : 'low'
  const qualityColor = safeVal >= 90 ? '#10b981' : safeVal >= 75 ? color : safeVal >= 60 ? '#f59e0b' : '#f43f5e'
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-28 h-28">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#1a2d50" strokeWidth="7"/>
          <circle cx="50" cy="50" r={r} fill="none" stroke={qualityColor} strokeWidth="7"
            strokeDasharray={c} strokeDashoffset={fill}
            strokeLinecap="round" className="gauge-arc"
            style={{ filter: `drop-shadow(0 0 8px ${qualityColor}70)`, transition: 'stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1)' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-body text-2xl font-bold leading-none" style={{ color: qualityColor }}>{safeVal}%</span>
          <span className="text-slate-500 font-mono text-xs mt-0.5">conf</span>
        </div>
      </div>
      <span className="font-mono text-xs px-2 py-0.5 rounded-full border"
        style={{ color: qualityColor, borderColor: qualityColor + '40', background: qualityColor + '10' }}>
        {qualityLabel}
      </span>
    </div>
  )
}
