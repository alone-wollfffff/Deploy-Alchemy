import { useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { SectionHeader } from './ModelOverview'

const MEDAL = ['🥇', '🥈', '🥉']

export default function Leaderboard({ metadata }) {
  const [sortBy, setSortBy] = useState('score_val')
  const [selectedModel, setSelectedModel] = useState(null)

  if (!metadata) return null
  const lb = metadata.leaderboard || []

  const sorted = [...lb].sort((a, b) => {
    const av = a[sortBy] ?? 0
    const bv = b[sortBy] ?? 0
    return bv - av
  })

  const chartData = sorted.slice(0, 10).map(m => ({
    name: (m.model || '').replace('_BAG_L1', '').replace('_BAG_L2', '').slice(0, 18),
    score: parseFloat((m.score_val ?? m.score ?? 0).toFixed(4)),
    full: m.model,
  }))

  const SORT_OPTIONS = [
    { key: 'score_val', label: 'Score' },
    { key: 'pred_time_val', label: 'Pred Speed' },
    { key: 'fit_time', label: 'Train Time' },
  ]

  return (
    <div className="space-y-6">

      {/* Chart */}
      <div className="glass glow-card rounded-xl p-5">
        <div className="flex items-center justify-between mb-5">
          <SectionHeader icon="📊" title="Model Comparison" subtitle="All trained candidates" />
          <div className="flex gap-1 bg-surface rounded-lg p-1">
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={`
                  px-3 py-1 rounded text-xs font-mono transition-all duration-200
                  ${sortBy === opt.key
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-500 hover:text-slate-300'}
                `}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 30, left: 0 }}>
              <XAxis
                dataKey="name"
                tick={{ fill: '#475569', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                angle={-35}
                textAnchor="end"
                interval={0}
              />
              <YAxis
                tick={{ fill: '#475569', fontSize: 10 }}
                width={45}
              />
              <Tooltip
                contentStyle={{ background: '#111d35', border: '1px solid #1a2d50', borderRadius: 8 }}
                labelStyle={{ color: '#94a3b8' }}
                formatter={(val) => [val.toFixed(4), sortBy === 'score_val' ? 'Score' : sortBy]}
              />
              <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                {chartData.map((_, i) => (
                  <Cell
                    key={i}
                    fill={i === 0 ? '#f59e0b' : i === 1 ? '#94a3b8' : i === 2 ? '#b45309' : 'rgba(0,245,255,0.3)'}
                    stroke={i === 0 ? '#f59e0b' : 'transparent'}
                    strokeWidth={i === 0 ? 1 : 0}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Table */}
      <div className="glass glow-card rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-3">
          <SectionHeader icon="🏆" title="Full Leaderboard" subtitle={`${lb.length} models evaluated`} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {['Rank', 'Model', 'Val Score', 'Train Time', 'Pred Time', 'Stack Level'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-slate-600 font-mono text-xs uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((model, i) => {
                const isSelected = selectedModel === model.model
                return (
                  <tr
                    key={i}
                    onClick={() => setSelectedModel(isSelected ? null : model.model)}
                    className={`
                      border-b border-border/30 cursor-pointer transition-all duration-150
                      ${isSelected ? 'bg-cyan-500/5' : 'hover:bg-card/50'}
                    `}
                  >
                    <td className="px-4 py-3">
                      <span className="text-sm">{MEDAL[i] || `#${i + 1}`}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-mono text-sm ${i === 0 ? 'text-yellow-300' : 'text-slate-300'}`}>
                        {model.model}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ScoreCell value={model.score_val ?? model.score} best={i === 0} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {model.fit_time != null ? `${model.fit_time.toFixed(1)}s` : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {model.pred_time_val != null ? `${(model.pred_time_val * 1000).toFixed(1)}ms` : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      L{model.stack_level ?? 1}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}

function ScoreCell({ value, best }) {
  if (value == null) return <span className="text-slate-600 font-mono text-xs">—</span>
  const display = typeof value === 'number' ? value.toFixed(4) : value
  return (
    <span className={`font-mono text-sm font-semibold ${best ? 'text-yellow-300' : 'text-slate-300'}`}>
      {display}
      {best && <span className="ml-1 text-yellow-500/60 text-xs">★</span>}
    </span>
  )
}
