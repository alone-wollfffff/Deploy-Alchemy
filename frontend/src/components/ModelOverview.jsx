import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

export default function ModelOverview({ metadata }) {
  if (!metadata) return <LoadingState />
  const m = metadata

  const statsCards = [
    { label: 'Task Type',      value: m.problem_type,  icon: '🎯', color: 'cyan'   },
    { label: 'Best Model',     value: m.best_model !== 'Unknown' ? m.best_model : null, icon: '🏆', color: 'gold'   },
    { label: 'Eval Metric',    value: m.eval_metric,   icon: '📐', color: 'purple' },
    { label: 'Input Features', value: m.num_features_original, icon: '🧬', color: 'jade'  },
    { label: 'Target Column',  value: m.label,         icon: '🎖️', color: 'ember'  },
    { label: 'Models Trained', value: m.leaderboard?.length || m.model_names?.length || '—', icon: '🤖', color: 'slate' },
  ]

  const topFeatures = (m.feature_importance || [])
    .slice(0, 10)
    .map(f => ({
      name: f.feature || f.name || f.index || '',
      importance: parseFloat((Math.abs(f.importance || f.score || 0)).toFixed(4)),
    }))
    .filter(f => f.name)

  const isClassification = ['binary', 'multiclass'].includes(m.problem_type)

  return (
    <div className="space-y-6">

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {statsCards.map(card => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      {/* Two column */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Feature importance */}
        {topFeatures.length > 0 && (
          <div className="glass glow-card rounded-xl p-5">
            <SectionHeader icon="🔥" title="Feature Importance" subtitle="Top contributing features" />
            <div className="mt-4 h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topFeatures} layout="vertical" margin={{ left: 0, right: 20 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'JetBrains Mono' }} width={110} />
                  <Tooltip
                    contentStyle={{ background: '#111d35', border: '1px solid #1a2d50', borderRadius: 8 }}
                    formatter={(val) => [val.toFixed(4), 'Importance']}
                  />
                  <Bar dataKey="importance" radius={[0, 4, 4, 0]}>
                    {topFeatures.map((_, i) => (
                      <Cell key={i} fill={`rgba(0,245,255,${Math.max(0.2, 1 - i * 0.08)})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Models leaderboard — FULL LIST, bigger panel */}
        <div className="glass glow-card rounded-xl p-5">
          <SectionHeader icon="🏅" title="Models Trained" subtitle={`${(m.leaderboard || []).length} AutoGluon candidates`} />
          <div className="mt-4 space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {(m.leaderboard || []).map((model, i) => {
              const score = model.score_val ?? model.score ?? 0
              const scores = (m.leaderboard || []).map(x => Math.abs(x.score_val ?? x.score ?? 0))
              const maxAbs = Math.max(...scores)
              const thisAbs = Math.abs(score)
              const pct = maxAbs > 0 ? (thisAbs / maxAbs) * 100 : 0
              const medals = ['🥇','🥈','🥉']
              return (
                <div key={i} className="flex items-center gap-3 py-1">
                  <span className="text-sm w-6 flex-shrink-0 text-center">
                    {medals[i] || <span className="text-slate-600 font-mono text-xs">#{i+1}</span>}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-mono truncate mb-1 ${i === 0 ? 'text-yellow-300' : 'text-slate-400'}`}>
                      {model.model}
                    </div>
                    <div className="w-full bg-border rounded-full h-1">
                      <div
                        className="h-1 rounded-full"
                        style={{ width: `${pct}%`, background: i === 0 ? '#f59e0b' : 'rgba(0,245,255,0.35)' }}
                      />
                    </div>
                  </div>
                  <span className="text-xs font-mono text-slate-500 flex-shrink-0 w-20 text-right">
                    {typeof score === 'number' ? score.toFixed(2) : score}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Classes for classification */}
      {isClassification && m.classes?.length > 0 && (
        <div className="glass glow-card rounded-xl p-5">
          <SectionHeader icon="🏷️" title="Target Classes" subtitle={`${m.classes.length} classes detected`} />
          <div className="mt-3 flex flex-wrap gap-2">
            {m.classes.map((cls, i) => (
              <span key={i} className="border border-cyan-900/50 bg-cyan-500/5 text-cyan-300 font-mono text-xs px-3 py-1.5 rounded-lg">
                {String(cls)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, color }) {
  const gradients = {
    cyan:   'from-cyan-500/10 to-cyan-500/5 border-cyan-500/20',
    gold:   'from-yellow-500/10 to-yellow-500/5 border-yellow-500/20',
    purple: 'from-purple-500/10 to-purple-500/5 border-purple-500/20',
    jade:   'from-emerald-500/10 to-emerald-500/5 border-emerald-500/20',
    ember:  'from-orange-500/10 to-orange-500/5 border-orange-500/20',
    slate:  'from-slate-500/10 to-slate-500/5 border-slate-500/20',
  }
  const textColors = {
    cyan: 'text-cyan-300', gold: 'text-yellow-300', purple: 'text-purple-300',
    jade: 'text-emerald-300', ember: 'text-orange-300', slate: 'text-slate-300',
  }
  const displayValue = value !== undefined && value !== null ? String(value) : null

  return (
    <div className={`glass rounded-xl p-4 border bg-gradient-to-br ${gradients[color]}`}>
      <div className="flex items-start gap-3">
        <span className="text-xl">{icon}</span>
        <div className="min-w-0">
          <div className="text-slate-500 font-mono text-xs uppercase tracking-wider mb-1">{label}</div>
          {displayValue ? (
            <div className={`font-body text-sm font-semibold truncate ${textColors[color]}`}>{displayValue}</div>
          ) : (
            <div className="text-slate-700 font-mono text-xs italic">Reading from model...</div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SectionHeader({ icon, title, subtitle }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-lg">{icon}</span>
      <div>
        <div className="text-slate-200 font-body font-semibold text-sm">{title}</div>
        {subtitle && <div className="text-slate-600 font-mono text-xs">{subtitle}</div>}
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="grid grid-cols-3 gap-4">
      {[...Array(6)].map((_, i) => <div key={i} className="glass glow-card rounded-xl p-4 h-20 shimmer" />)}
    </div>
  )
}
