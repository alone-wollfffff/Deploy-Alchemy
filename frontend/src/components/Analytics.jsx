import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { SectionHeader } from './ModelOverview'

export default function Analytics({ metadata }) {
  if (!metadata) return null

  const fi = (metadata.feature_importance || []).slice(0, 15).map((f, i) => ({
    feature: f.feature || f.name || `Feature ${i}`,
    importance: parseFloat((Math.abs(f.importance || f.score || 0)).toFixed(4)),
    raw: f.importance || 0,
  })).sort((a, b) => b.importance - a.importance)

  const lb = metadata.leaderboard || []

  // Model type distribution for radar
  // Extract base algorithm name: CatBoost_BAG_L1 → CatBoost, WeightedEnsemble_L2 → WgtEnsemble
  const modelTypes = {}
  lb.forEach(m => {
    const raw = (m.model || '')
    // Skip FULL variants to avoid double-counting
    if (raw.endsWith('_FULL')) return
    const type = raw.split('_')[0].replace('WeightedEnsemble', 'WgtEnsemble')
    modelTypes[type] = (modelTypes[type] || 0) + 1
  })
  const radarData = Object.entries(modelTypes).map(([name, count]) => ({
    subject: name.slice(0, 14),
    count,
  })).sort((a, b) => b.count - a.count)

  // Score distribution — filter out null scores (NaN converted by backend)
  const scoreDist = lb
    .filter(m => m.score_val != null && m.fit_time != null)
    .map(m => ({
      score: parseFloat((+(m.score_val ?? m.score ?? 0)).toFixed(4)),
      trainTime: parseFloat((+(m.fit_time ?? 0)).toFixed(1)),
      name: (m.model || '').replace('_FULL', '').slice(0, 20),
    }))
    .filter(m => isFinite(m.score) && isFinite(m.trainTime))

  return (
    <div className="space-y-6">

      {/* Feature importance full chart */}
      {fi.length > 0 && (
        <div className="glass glow-card rounded-xl p-5">
          <SectionHeader
            icon="🔥"
            title="Feature Importance"
            subtitle={`Top ${fi.length} features by predictive power`}
          />
          <div className="mt-4 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fi} layout="vertical" margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
                <XAxis
                  type="number"
                  tick={{ fill: '#475569', fontSize: 10 }}
                  tickFormatter={v => v.toFixed(3)}
                />
                <YAxis
                  type="category"
                  dataKey="feature"
                  tick={{ fill: '#64748b', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  width={130}
                />
                <Tooltip
                  contentStyle={{ background: '#111d35', border: '1px solid #1a2d50', borderRadius: 8 }}
                  labelStyle={{ color: '#94a3b8' }}
                  cursor={{ fill: 'rgba(0,245,255,0.04)' }}
                  formatter={(val) => [val.toFixed(4), 'Importance']}
                />
                <Bar dataKey="importance" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {fi.map((_, i) => (
                    <Cell
                      key={i}
                      fill={`rgba(0,245,255,${Math.max(0.15, 1 - i * 0.06)})`}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Score vs Train Time scatter */}
      {scoreDist.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="glass glow-card rounded-xl p-5">
            <SectionHeader
              icon="⏱️"
              title="Score vs Train Time"
              subtitle="Efficiency tradeoff across models"
            />
            <div className="mt-4 h-52">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                  <XAxis
                    dataKey="trainTime"
                    name="Train Time"
                    unit="s"
                    tick={{ fill: '#475569', fontSize: 10 }}
                    label={{ value: 'Train Time (s)', position: 'bottom', fill: '#475569', fontSize: 10 }}
                  />
                  <YAxis
                    dataKey="score"
                    name="Score"
                    tick={{ fill: '#475569', fontSize: 10 }}
                    width={50}
                    tickFormatter={v => v.toFixed(3)}
                  />
                  <ZAxis range={[40, 40]} />
                  <Tooltip
                    contentStyle={{ background: '#111d35', border: '1px solid #1a2d50', borderRadius: 8 }}
                    cursor={{ strokeDasharray: '3 3', stroke: '#1a2d50' }}
                    formatter={(val, name) => [
                      name === 'Score' ? val.toFixed(4) : `${val}s`,
                      name
                    ]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.name || ''}
                    labelStyle={{ color: '#94a3b8', marginBottom: 4 }}
                  />
                  <Scatter
                    data={scoreDist}
                    fill="rgba(0,245,255,0.5)"
                    stroke="#00f5ff"
                    strokeWidth={1}
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Model type distribution */}
          {radarData.length >= 2 && (
            <div className="glass glow-card rounded-xl p-5">
              <SectionHeader
                icon="🤖"
                title="Algorithm Mix"
                subtitle="Model type distribution"
              />
              <div className="mt-4 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                    <PolarGrid stroke="#1a2d50" />
                    <PolarAngleAxis
                      dataKey="subject"
                      tick={{ fill: '#475569', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                    />
                    <PolarRadiusAxis tick={false} axisLine={false} />
                    <Radar
                      name="Count"
                      dataKey="count"
                      stroke="#7c3aed"
                      fill="rgba(124,58,237,0.15)"
                      strokeWidth={1.5}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Performance summary cards */}
      <div className="glass glow-card rounded-xl p-5">
        <SectionHeader icon="📈" title="Performance Summary" subtitle="Key training insights" />
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          {lb.length > 0 && (() => {
            const scores = lb.map(m => m.score_val ?? m.score ?? 0)
            const bestScore = Math.max(...scores)
            const worstScore = Math.min(...scores)
            const avgScore = scores.reduce((a,b) => a+b, 0) / scores.length
            const totalTime = lb.reduce((a,m) => a + (m.fit_time || 0), 0)

            return [
              { label: 'Best Score', value: bestScore.toFixed(4), color: 'text-yellow-300' },
              { label: 'Avg Score', value: avgScore.toFixed(4), color: 'text-cyan-300' },
              { label: 'Score Range', value: (bestScore - worstScore).toFixed(4), color: 'text-purple-300' },
              { label: 'Total Train', value: `${totalTime.toFixed(0)}s`, color: 'text-orange-300' },
            ].map(item => (
              <div key={item.label} className="bg-surface/80 rounded-lg p-3 text-center glow-card">
                <div className="text-slate-600 font-mono text-xs mb-1">{item.label}</div>
                <div className={`font-body text-lg font-bold ${item.color}`}>{item.value}</div>
              </div>
            ))
          })()}
        </div>
      </div>

    </div>
  )
}
