import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import toast from 'react-hot-toast'
import Papa from 'papaparse'
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, BarChart, Bar,
} from 'recharts'
import { SectionHeader } from './ModelOverview'

// ── Toast helpers ────────────────────────────────────────────────────────
function showErrorToast(msg) {
  toast.error(msg, {
    duration: 10000,
    style: {
      maxWidth: '520px',
      whiteSpace: 'pre-line',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '12px',
      lineHeight: '1.6',
      background: 'rgba(17,10,20,0.97)',
      border: '1px solid rgba(244,63,94,0.4)',
      color: '#f87171',
    }
  })
}

function showInfoToast(msg) {
  toast(msg, {
    icon: '⚠️',
    duration: 8000,
    style: {
      maxWidth: '480px',
      whiteSpace: 'pre-line',
      background: 'rgba(17,29,53,0.97)',
      color: '#fcd34d',
      border: '1px solid rgba(245,158,11,0.35)',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: '12px',
    }
  })
}

export default function BatchPrediction({ deployment }) {
  const [activeTab, setActiveTab] = useState('predict')
  const TABS = [
    { id: 'predict', label: 'Batch Predict', icon: '📊' },
    { id: 'test',    label: 'Test Model',    icon: '🧪' },
  ]
  return (
    <div className="space-y-5">
      <div className="flex gap-1 bg-surface rounded-xl p-1 w-fit border border-border/50">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200
              ${activeTab === t.id ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>
      {activeTab === 'predict' && <BatchPredict deployment={deployment} />}
      {activeTab === 'test'    && <TestModel    deployment={deployment} />}
    </div>
  )
}

/* ── BATCH PREDICT ─────────────────────────────────────────────────────────── */
function BatchPredict({ deployment }) {
  const [file, setFile]       = useState(null)
  const [preview, setPreview] = useState(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState(null)

  const onDrop = useCallback((files) => {
    const f = files[0]; if (!f) return
    setFile(f); setResults(null)
    Papa.parse(f, { header: true, preview: 5,
      complete: r => setPreview({ rows: r.data, headers: r.meta.fields || [], totalRows: '?' }) })
    const rd = new FileReader()
    rd.onload = e => setPreview(p => p ? { ...p, totalRows: e.target.result.split('\n').length - 1 } : null)
    rd.readAsText(f)
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'text/csv': ['.csv'] }, multiple: false,
  })

  const run = async () => {
    setRunning(true); setProgress(0)
    const fd = new FormData(); fd.append('file', file)
    const iv = setInterval(() => setProgress(p => Math.min(p + Math.random() * 14, 88)), 400)
    try {
      const res = await axios.post(`/api/session/${deployment.sessionId}/predict-batch`, fd, { responseType: 'blob' })
      clearInterval(iv); setProgress(100)

      // Check if response is actually an error JSON blob
      const contentType = res.headers['content-type'] || ''
      if (contentType.includes('application/json')) {
        const errText = await res.data.text()
        const errJson = JSON.parse(errText)
        throw new Error(errJson.detail || 'Server returned an error')
      }

      const text   = await res.data.text()
      const parsed = Papa.parse(text, { header: true })
      setResults({ blob: res.data, rows: parsed.data.slice(0, 10), headers: parsed.meta.fields || [], total: parsed.data.length })
      toast.success(`✅ ${parsed.data.length.toLocaleString()} predictions complete!`)
      const warning = res.headers?.['x-schema-warning']
      if (warning) {
        setTimeout(() => showInfoToast(warning), 500)
      }
    } catch(err) {
      clearInterval(iv)
      // Blob-mode: error body is also a blob — read it
      let msg = err.message || 'Batch prediction failed'
      if (err.response?.data instanceof Blob) {
        try {
          const txt = await err.response.data.text()
          const parsed = JSON.parse(txt)
          msg = parsed.detail || msg
        } catch { /* use original msg */ }
      } else {
        msg = err.response?.data?.detail || msg
      }
      showErrorToast(msg)
    } finally { setRunning(false) }
  }

  const download = () => {
    const url = URL.createObjectURL(results.blob)
    Object.assign(document.createElement('a'), { href: url, download: 'predictions.csv' }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="📋" title="Batch Prediction" subtitle="Upload CSV — feature columns only, no target needed" />
        <div className="mt-5">
          <div {...getRootProps()}
            className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all duration-200
              ${isDragActive ? 'border-cyan-400 bg-cyan-500/5' : 'border-border hover:border-border/70 hover:bg-card/30'}`}>
            <input {...getInputProps()} />
            {file ? (
              <div>
                <div className="text-2xl mb-2">📄</div>
                <div className="text-slate-300 text-sm font-medium">{file.name}</div>
                <div className="text-slate-600 font-mono text-xs mt-1">
                  {(file.size/1024).toFixed(1)} KB{preview ? ` · ${preview.totalRows} rows` : ''}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-2xl mb-2 opacity-40">📊</div>
                <p className="text-slate-400 text-sm">Drop CSV here or click to browse</p>
                <p className="text-slate-600 font-mono text-xs mt-1">Feature columns only (no target column needed)</p>
              </div>
            )}
          </div>
        </div>

        {/* Preview table */}
        {preview && !results && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-surface border-b border-border">
                {preview.headers.slice(0,6).map(h => <th key={h} className="px-3 py-2 text-left text-slate-500">{h}</th>)}
                {preview.headers.length > 6 && <th className="px-3 py-2 text-slate-700">+{preview.headers.length-6}</th>}
              </tr></thead>
              <tbody>{preview.rows.map((row,i) => (
                <tr key={i} className="border-b border-border/30">
                  {preview.headers.slice(0,6).map(h => <td key={h} className="px-3 py-1.5 text-slate-400 truncate max-w-24">{String(row[h]??'—')}</td>)}
                  {preview.headers.length > 6 && <td className="px-3 py-1.5 text-slate-700">...</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {/* Progress */}
        {running && (
          <div className="mt-4">
            <div className="flex justify-between mb-1.5">
              <span className="text-cyan-400 font-mono text-xs">Processing...</span>
              <span className="text-slate-500 font-mono text-xs">{Math.round(progress)}%</span>
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-2 rounded-full transition-all duration-300"
                style={{ width:`${progress}%`, background:'linear-gradient(90deg,#7c3aed,#00f5ff)' }}/>
            </div>
          </div>
        )}

        {file && !results && (
          <button onClick={run} disabled={running}
            className={`mt-4 w-full py-3 rounded-xl font-body font-semibold text-sm transition-all duration-200
              ${running ? 'bg-surface border border-border text-slate-600 cursor-wait' : 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/15'}`}>
            {running ? '⏳ Processing...' : '⚡ Run Batch Predictions'}
          </button>
        )}
      </div>

      {/* Results */}
      {results && (
        <div className="glass glow-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <SectionHeader icon="✅" title="Predictions Ready" subtitle={`${results.total} rows complete`} />
            <button onClick={download}
              className="flex items-center gap-2 px-4 py-2 bg-jade/10 border border-jade/30 text-emerald-300 rounded-lg text-sm font-body font-medium hover:bg-jade/15 transition-colors">
              ↓ Download CSV
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-surface border-b border-border">
                {results.headers.slice(0,7).map(h => (
                  <th key={h} className={`px-3 py-2 text-left ${h==='prediction'?'text-cyan-500':h==='confidence'?'text-emerald-500':h.startsWith('prob_')?'text-purple-500':'text-slate-500'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{results.rows.map((row,i) => {
                const conf = parseFloat(row.confidence)
                const low = !isNaN(conf) && conf < 0.6
                return (
                  <tr key={i} className={`border-b border-border/30 ${low?'bg-rose-500/3':''}`}>
                    {results.headers.slice(0,7).map(h => (
                      <td key={h} className={`px-3 py-1.5 ${h==='prediction'?'text-cyan-400 font-bold':h==='confidence'&&low?'text-rose-400':'text-slate-400'}`}>
                        {h==='confidence'&&!isNaN(parseFloat(row[h]))?`${(parseFloat(row[h])*100).toFixed(1)}%`:String(row[h]??'—')}
                        {h==='confidence'&&low&&' ⚠️'}
                      </td>
                    ))}
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
          <button onClick={() => { setFile(null); setPreview(null); setResults(null) }}
            className="mt-4 text-slate-600 hover:text-slate-400 font-mono text-xs transition-colors">← New batch</button>
        </div>
      )}
    </div>
  )
}

/* ── TEST MODEL ────────────────────────────────────────────────────────────── */
function TestModel({ deployment }) {
  const [file, setFile]       = useState(null)
  const [preview, setPreview] = useState(null)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)

  const meta         = deployment?.metadata || {}
  const targetCol    = meta.label || 'target'
  const isRegression = meta.problem_type === 'regression'

  const onDrop = useCallback((files) => {
    const f = files[0]; if (!f) return
    setFile(f); setResults(null)
    Papa.parse(f, { header: true, preview: 5,
      complete: r => setPreview({ rows: r.data, headers: r.meta.fields || [] }) })
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'text/csv': ['.csv'] }, multiple: false,
  })

  const run = async () => {
    setRunning(true)
    const fd = new FormData(); fd.append('file', file)
    try {
      const res = await axios.post(`/api/session/${deployment.sessionId}/test-model`, fd)
      setResults(res.data)
      toast.success(`✅ Evaluated on ${res.data.n_samples?.toLocaleString()} samples!`)
      if (res.data.schema_warning) {
        setTimeout(() => showInfoToast(res.data.schema_warning), 600)
      }
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || 'Evaluation failed'
      toast.error(msg, { duration: 9000, style: { maxWidth: '520px', whiteSpace: 'pre-line', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' } })
    } finally { setRunning(false) }
  }

  return (
    <div className="space-y-5">
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="🧪" title="Test Model" subtitle={`Upload CSV with features + actual "${targetCol}" column — we'll compare predictions vs actuals`} />

        <div className="mt-3 flex items-start gap-3 bg-purple-500/5 border border-purple-500/20 rounded-lg px-4 py-3">
          <span className="text-purple-400 text-sm flex-shrink-0">ℹ️</span>
          <p className="text-purple-300/80 font-mono text-xs leading-relaxed">
            Your CSV must include both feature columns AND the target column
            <span className="text-purple-300 font-semibold"> "{targetCol}" </span>
            with real values. We predict from features and compare against actuals to measure performance.
          </p>
        </div>

        <div className="mt-4">
          <div {...getRootProps()}
            className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all duration-200
              ${isDragActive ? 'border-purple-400 bg-purple-500/5' : 'border-border hover:border-border/70'}`}>
            <input {...getInputProps()} />
            {file ? (
              <div>
                <div className="text-2xl mb-2">📄</div>
                <div className="text-slate-300 text-sm font-medium">{file.name}</div>
                <div className="text-slate-600 font-mono text-xs mt-1">{(file.size/1024).toFixed(1)} KB</div>
              </div>
            ) : (
              <div>
                <div className="text-2xl mb-2 opacity-40">🧪</div>
                <p className="text-slate-400 text-sm">Drop CSV with <span className="text-purple-400">"{targetCol}"</span> column</p>
                <p className="text-slate-600 font-mono text-xs mt-1">Features + actual values included</p>
              </div>
            )}
          </div>
        </div>

        {/* Preview — highlight target column */}
        {preview && !results && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-surface border-b border-border">
                {preview.headers.slice(0,7).map(h => (
                  <th key={h} className={`px-3 py-2 text-left ${h===targetCol?'text-purple-400':'text-slate-500'}`}>
                    {h===targetCol?`★ ${h}`:h}
                  </th>
                ))}
              </tr></thead>
              <tbody>{preview.rows.map((row,i) => (
                <tr key={i} className="border-b border-border/30">
                  {preview.headers.slice(0,7).map(h => (
                    <td key={h} className={`px-3 py-1.5 truncate max-w-24 ${h===targetCol?'text-purple-300 font-semibold':'text-slate-400'}`}>
                      {String(row[h]??'—')}
                    </td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {file && !results && (
          <button onClick={run} disabled={running}
            className={`mt-4 w-full py-3 rounded-xl font-body font-semibold text-sm transition-all duration-200
              ${running ? 'bg-surface border border-border text-slate-600 cursor-wait' : 'bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/15'}`}>
            {running
              ? <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin"/>
                  Evaluating model...
                </span>
              : '🧪 Run Evaluation'}
          </button>
        )}
      </div>

      {/* ── RESULTS ── */}
      {results && (
        <>
          {/* Metric cards */}
          <div className="glass glow-card rounded-xl p-5">
            <SectionHeader icon="📊" title="Evaluation Results"
              subtitle={`${results.n_samples?.toLocaleString()} samples · ${results.problem_type}`} />
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(results.metrics || {}).map(([k, v]) =>
                v !== null && v !== undefined ? <MetricCard key={k} name={k} value={v} /> : null
              )}
            </div>
          </div>

          {/* Regression: Actual vs Predicted scatter */}
          {isRegression && results.scatter?.length > 0 && (
            <div className="glass glow-card rounded-xl p-5">
              <SectionHeader icon="🎯" title="Actual vs Predicted"
                subtitle="Points near the diagonal = accurate predictions" />
              <div className="mt-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top:10, right:20, bottom:30, left:20 }}>
                    <CartesianGrid stroke="#1a2d50" strokeDasharray="3 3" />
                    <XAxis dataKey="actual" type="number" name="Actual"
                      tick={{ fill:'#475569', fontSize:10, fontFamily:'JetBrains Mono' }}
                      label={{ value:'Actual', position:'bottom', offset:10, fill:'#475569', fontSize:11 }} />
                    <YAxis dataKey="predicted" type="number" name="Predicted"
                      tick={{ fill:'#475569', fontSize:10, fontFamily:'JetBrains Mono' }} width={60}
                      label={{ value:'Predicted', angle:-90, position:'insideLeft', fill:'#475569', fontSize:11 }} />
                    <ZAxis range={[18, 18]} />
                    <Tooltip contentStyle={{ background:'#111d35', border:'1px solid #1a2d50', borderRadius:8 }}
                      formatter={(v, n) => [typeof v==='number'?v.toFixed(4):v, n]} />
                    <Scatter data={results.scatter} fill="rgba(0,245,255,0.45)" stroke="#00f5ff" strokeWidth={0.5} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <p className="text-slate-700 font-mono text-xs mt-2 text-center">Showing up to 300 sampled points</p>
            </div>
          )}

          {/* Classification: Confusion Matrix */}
          {!isRegression && results.confusion_matrix && (
            <ConfusionMatrix cm={results.confusion_matrix} />
          )}

          {/* Per-class metrics bar chart */}
          {!isRegression && results.per_class && Object.keys(results.per_class).length > 0 && (
            <PerClassMetrics data={results.per_class} />
          )}

          <button onClick={() => { setFile(null); setPreview(null); setResults(null) }}
            className="text-slate-600 hover:text-slate-400 font-mono text-xs transition-colors">← New evaluation</button>
        </>
      )}
    </div>
  )
}

/* ── METRIC CARD ─────────────────────────────────────────────────────────────*/
function MetricCard({ name, value }) {
  const num = parseFloat(value)
  const isPercent = ['Accuracy','R²','ROC-AUC','Weighted F1','Precision','Recall'].includes(name)
  const color = (() => {
    if (!isPercent) return 'text-cyan-300'
    if (num >= 0.9) return 'text-emerald-300'
    if (num >= 0.7) return 'text-cyan-300'
    if (num >= 0.5) return 'text-yellow-300'
    return 'text-rose-300'
  })()
  const display = typeof value === 'number'
    ? (Math.abs(value) < 10 ? value.toFixed(4) : value.toFixed(2)) : String(value)
  return (
    <div className="bg-surface/80 rounded-xl p-4 text-center border border-border/50 glow-card">
      <div className="text-slate-600 font-mono text-xs mb-2 uppercase tracking-wider">{name}</div>
      <div className={`font-body text-xl font-bold ${color}`}>{display}</div>
      {isPercent && !isNaN(num) && (
        <div className="mt-2 h-1 bg-border rounded-full overflow-hidden">
          <div className="h-1 rounded-full transition-all duration-700"
            style={{ width:`${Math.max(0,Math.min(100,num*100))}%`,
              background: num>=0.9?'#10b981':num>=0.7?'#00f5ff':num>=0.5?'#f59e0b':'#f43f5e' }} />
        </div>
      )}
    </div>
  )
}

/* ── CONFUSION MATRIX ────────────────────────────────────────────────────────*/
function ConfusionMatrix({ cm }) {
  const { matrix, labels } = cm
  const maxVal = Math.max(...matrix.flat())
  const total  = matrix.flat().reduce((a,b)=>a+b,0)
  return (
    <div className="glass glow-card rounded-xl p-5">
      <SectionHeader icon="🔲" title="Confusion Matrix"
        subtitle="Rows = actual · Columns = predicted · Diagonal = correct" />
      <div className="mt-4 overflow-x-auto">
        <table className="font-mono text-xs border-collapse">
          <thead>
            <tr>
              <th className="px-3 py-2 text-slate-700 text-right text-xs font-normal">actual ↓ / pred →</th>
              {labels.map(l => <th key={l} className="px-4 py-2 text-center text-cyan-500 border border-border min-w-16">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row,i) => {
              const rt = row.reduce((a,b)=>a+b,0)
              return (
                <tr key={i}>
                  <td className="px-3 py-2 text-cyan-500 border border-border text-right font-semibold">{labels[i]}</td>
                  {row.map((val,j) => {
                    const diag = i===j
                    const intensity = maxVal>0?val/maxVal:0
                    const bg = diag ? `rgba(0,245,255,${0.04+intensity*0.22})` : val>0 ? `rgba(244,63,94,${0.04+intensity*0.18})` : 'transparent'
                    const pct = rt>0?((val/rt)*100).toFixed(0):0
                    return (
                      <td key={j} className="px-4 py-2 text-center border border-border" style={{background:bg}} title={`${val} (${pct}% of row)`}>
                        <span className={diag?'text-cyan-300 font-bold':val>0?'text-rose-400':'text-slate-700'}>{val}</span>
                        {val>0&&<span className="block text-slate-600" style={{fontSize:9}}>{pct}%</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-slate-700 font-mono text-xs mt-3">Cyan diagonal = correct · Red off-diagonal = wrong · Total: {total}</p>
    </div>
  )
}

/* ── PER-CLASS METRICS ───────────────────────────────────────────────────────*/
function PerClassMetrics({ data }) {
  const chartData = Object.keys(data).map(cls => ({
    class:     String(cls).slice(0,14),
    precision: data[cls].precision    ?? 0,
    recall:    data[cls].recall       ?? 0,
    f1:        data[cls]['f1-score']  ?? 0,
  }))
  return (
    <div className="glass glow-card rounded-xl p-5">
      <SectionHeader icon="📋" title="Per-Class Metrics" subtitle={`${chartData.length} classes`} />
      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top:5, right:10, bottom:25, left:0 }}>
            <XAxis dataKey="class" tick={{ fill:'#475569', fontSize:9, fontFamily:'JetBrains Mono' }}
              angle={-30} textAnchor="end" interval={0} />
            <YAxis domain={[0,1]} tick={{ fill:'#475569', fontSize:10 }}
              tickFormatter={v=>v.toFixed(1)} width={32} />
            <Tooltip contentStyle={{ background:'#111d35', border:'1px solid #1a2d50', borderRadius:8 }}
              formatter={(v,n)=>[v.toFixed(4),n]} />
            <Bar dataKey="precision" name="Precision" fill="rgba(0,245,255,0.6)"   radius={[2,2,0,0]} />
            <Bar dataKey="recall"    name="Recall"    fill="rgba(124,58,237,0.6)"  radius={[2,2,0,0]} />
            <Bar dataKey="f1"        name="F1 Score"  fill="rgba(249,115,22,0.6)"  radius={[2,2,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-5 mt-2 justify-center">
        {[['Precision','rgba(0,245,255,0.6)'],['Recall','rgba(124,58,237,0.6)'],['F1 Score','rgba(249,115,22,0.6)']].map(([l,c])=>(
          <div key={l} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={{background:c}} />
            <span className="text-slate-500 font-mono text-xs">{l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
