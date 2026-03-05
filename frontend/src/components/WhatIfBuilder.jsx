import { useState } from 'react'
import axios from 'axios'
import toast from 'react-hot-toast'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid,
} from 'recharts'
import { SectionHeader } from './ModelOverview'

export default function WhatIfBuilder({ deployment }) {
  const [baseInputs, setBaseInputs] = useState({})
  const [varyFeature, setVaryFeature] = useState('')
  const [rangeMin, setRangeMin] = useState('')
  const [rangeMax, setRangeMax] = useState('')
  const [steps, setSteps] = useState(20)
  const [running, setRunning] = useState(false)
  const [chartData, setChartData] = useState(null)

  const schema = deployment?.metadata?.input_schema || []
  const selectedField = schema.find(f => f.name === varyFeature)

  const handleRun = async () => {
    if (!varyFeature) { toast.error('Select a feature to vary'); return }
    if (!rangeMin && rangeMin !== 0) { toast.error('Set a min value'); return }
    if (!rangeMax && rangeMax !== 0) { toast.error('Set a max value'); return }

    setRunning(true)
    setChartData(null)

    const min = parseFloat(rangeMin)
    const max = parseFloat(rangeMax)
    const step = (max - min) / (steps - 1)
    const rangeValues = Array.from({ length: steps }, (_, i) =>
      parseFloat((min + i * step).toFixed(4))
    )

    try {
      const res = await axios.post(`/api/session/${deployment.sessionId}/whatif`, {
        base_inputs: baseInputs,
        vary_feature: varyFeature,
        range_values: rangeValues,
      })

      const data = res.data.results.map(r => ({
        x: r.value,
        confidence: r.confidence != null ? parseFloat((r.confidence * 100).toFixed(2)) : null,
        prediction: r.prediction,
      }))

      setChartData(data)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'What-If analysis failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader
          icon="⚡"
          title="What-If Builder"
          subtitle="Vary one feature and see how prediction changes"
        />

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5">

          {/* Left - base inputs */}
          <div>
            <div className="text-slate-500 font-mono text-xs uppercase tracking-wider mb-3">
              Base Inputs (optional — uses medians if empty)
            </div>
            <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
              {schema.slice(0, 8).map(field => (
                <div key={field.name}>
                  <label className="text-slate-600 font-mono text-xs block mb-1">{field.name}</label>
                  <input
                    type={field.widget === 'number' ? 'number' : 'text'}
                    value={baseInputs[field.name] || ''}
                    onChange={e => setBaseInputs(p => ({ ...p, [field.name]: e.target.value }))}
                    placeholder={field.median != null ? `${field.median}` : '—'}
                    className="w-full bg-surface border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-slate-300 outline-none focus:border-cyan-500/40"
                    step="any"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Right - vary settings */}
          <div className="space-y-4">
            <div>
              <label className="text-slate-500 font-mono text-xs uppercase tracking-wider block mb-2">
                Feature to Vary
              </label>
              <select
                value={varyFeature}
                onChange={e => {
                  setVaryFeature(e.target.value)
                  const field = schema.find(f => f.name === e.target.value)
                  if (field) {
                    if (field.min != null) setRangeMin(field.min)
                    if (field.max != null) setRangeMax(field.max)
                  }
                }}
                className="w-full bg-surface border border-border text-slate-300 font-mono text-sm rounded-lg px-3 py-2 outline-none focus:border-cyan-500/40"
              >
                <option value="">Select feature...</option>
                {schema.map(f => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-500 font-mono text-xs block mb-1.5">Min Value</label>
                <input
                  type="number"
                  value={rangeMin}
                  onChange={e => setRangeMin(e.target.value)}
                  placeholder={selectedField?.min ?? '0'}
                  className="w-full bg-surface border border-border text-slate-300 font-mono text-sm rounded-lg px-3 py-2 outline-none focus:border-cyan-500/40"
                  step="any"
                />
              </div>
              <div>
                <label className="text-slate-500 font-mono text-xs block mb-1.5">Max Value</label>
                <input
                  type="number"
                  value={rangeMax}
                  onChange={e => setRangeMax(e.target.value)}
                  placeholder={selectedField?.max ?? '100'}
                  className="w-full bg-surface border border-border text-slate-300 font-mono text-sm rounded-lg px-3 py-2 outline-none focus:border-cyan-500/40"
                  step="any"
                />
              </div>
            </div>

            <div>
              <label className="text-slate-500 font-mono text-xs block mb-1.5">Steps: {steps}</label>
              <input
                type="range"
                min={5} max={50} value={steps}
                onChange={e => setSteps(parseInt(e.target.value))}
                className="w-full accent-cyan-400"
              />
            </div>

            <button
              onClick={handleRun}
              disabled={running}
              className={`
                w-full py-3 rounded-xl font-body font-semibold text-sm transition-all duration-200
                ${running
                  ? 'bg-surface border border-border text-slate-600 cursor-wait'
                  : 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/15'}
              `}
            >
              {running ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
                  Running analysis...
                </span>
              ) : '⚡ Run What-If Analysis'}
            </button>
          </div>
        </div>
      </div>

      {/* Chart */}
      {chartData && (
        <div className="glass glow-card rounded-xl p-5">
          <SectionHeader
            icon="📈"
            title={`Effect of "${varyFeature}"`}
            subtitle="Confidence as feature varies"
          />

          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid stroke="#1a2d50" strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  tick={{ fill: '#475569', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  label={{ value: varyFeature, position: 'bottom', fill: '#475569', fontSize: 10 }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  tickFormatter={v => `${v}%`}
                  width={45}
                />
                <Tooltip
                  contentStyle={{ background: '#111d35', border: '1px solid #1a2d50', borderRadius: 8 }}
                  formatter={(val, name) => [
                    name === 'confidence' ? `${val?.toFixed(1)}%` : val,
                    name === 'confidence' ? 'Confidence' : 'Prediction'
                  ]}
                  labelFormatter={v => `${varyFeature}: ${v}`}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <ReferenceLine y={50} stroke="#1a2d50" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="confidence"
                  stroke="#00f5ff"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#00f5ff', strokeWidth: 0 }}
                  style={{ filter: 'drop-shadow(0 0 4px rgba(0,245,255,0.4))' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Insight summary */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            {(() => {
              const validData = chartData.filter(d => d.confidence != null)
              if (!validData.length) return null
              const maxConf = Math.max(...validData.map(d => d.confidence))
              const minConf = Math.min(...validData.map(d => d.confidence))
              const maxX = validData.find(d => d.confidence === maxConf)?.x
              const range = maxConf - minConf
              return [
                { label: 'Peak Confidence', value: `${maxConf.toFixed(1)}%`, sub: `at ${maxX}`, color: 'text-cyan-300' },
                { label: 'Min Confidence', value: `${minConf.toFixed(1)}%`, sub: 'lowest', color: 'text-slate-400' },
                { label: 'Sensitivity', value: `${range.toFixed(1)}%`, sub: 'range', color: range > 20 ? 'text-orange-300' : 'text-emerald-300' },
              ].map(item => (
                <div key={item.label} className="bg-surface/80 rounded-lg p-3 text-center glow-card">
                  <div className="text-slate-600 font-mono text-xs mb-1">{item.label}</div>
                  <div className={`font-body text-base font-bold ${item.color}`}>{item.value}</div>
                  <div className="text-slate-700 font-mono text-xs">{item.sub}</div>
                </div>
              ))
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
