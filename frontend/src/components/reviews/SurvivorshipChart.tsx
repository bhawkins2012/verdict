import {
  XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart
} from 'recharts'
import { STAGE_LABELS, ReviewStage } from '../../types'

interface DataPoint {
  stage: ReviewStage
  avgScore: number
  count: number
}

interface Props {
  data: DataPoint[]
  showUserLine?: { stage: ReviewStage; score: number }[]
}

interface TooltipEntry {
  dataKey: string
  name: string
  value: number | string
  color: string
  payload: { count?: number }
}

interface TooltipProps {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string
}

interface ChartPoint extends DataPoint {
  stageLabel: string
  userScore?: number
}

const CustomTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-ink-200 rounded-xl p-3 shadow-lg text-sm">
      <p className="font-medium text-ink-800 mb-1">{STAGE_LABELS[label as ReviewStage] || label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }} className="text-xs">
          {p.name}: <strong>{typeof p.value === 'number' ? p.value.toFixed(1) : p.value}</strong>
          {p.dataKey === 'avgScore' && p.payload.count && (
            <span className="text-ink-400 ml-1">({p.payload.count} reviewers)</span>
          )}
        </p>
      ))}
    </div>
  )
}

export function SurvivorshipChart({ data, showUserLine }: Props) {
  // Merge the user's own line if provided
  const userMap: Partial<Record<ReviewStage, number>> = showUserLine
    ? Object.fromEntries(showUserLine.map(r => [r.stage, r.score]))
    : {}
  const chartData: ChartPoint[] = data.map(d => ({
    ...d,
    stageLabel: STAGE_LABELS[d.stage] || d.stage,
    userScore: userMap[d.stage],
  }))

  const minScore = Math.max(0, Math.min(...data.map(d => d.avgScore)) - 1)
  const maxScore = Math.min(10, Math.max(...data.map(d => d.avgScore)) + 1)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -15 }}>
        <defs>
          <linearGradient id="communityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#d97706" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#d97706" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="userGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#4CAF7D" stopOpacity={0.2} />
            <stop offset="95%" stopColor="#4CAF7D" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#e8e4de" vertical={false} />
        <XAxis
          dataKey="stageLabel"
          tick={{ fontSize: 10, fill: '#9a8a77' }}
          tickLine={false}
          axisLine={false}
          interval={0}
        />
        <YAxis
          domain={[minScore, maxScore]}
          tick={{ fontSize: 10, fill: '#9a8a77' }}
          tickLine={false}
          axisLine={false}
          tickCount={5}
        />
        <Tooltip content={<CustomTooltip />} />

        {/* Reference line at 7 — "good" threshold */}
        <ReferenceLine y={7} stroke="#e8e4de" strokeDasharray="4 4" />

        {/* Community average */}
        <Area
          type="monotone"
          dataKey="avgScore"
          name="Community avg"
          stroke="#d97706"
          strokeWidth={2.5}
          fill="url(#communityGrad)"
          dot={{ fill: '#d97706', r: 3, strokeWidth: 0 }}
          activeDot={{ r: 5, strokeWidth: 0 }}
        />

        {/* User's own scores (optional overlay) */}
        {showUserLine && (
          <Area
            type="monotone"
            dataKey="userScore"
            name="Your score"
            stroke="#4CAF7D"
            strokeWidth={2}
            strokeDasharray="5 3"
            fill="url(#userGrad)"
            dot={{ fill: '#4CAF7D', r: 3, strokeWidth: 0 }}
            connectNulls
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  )
}
