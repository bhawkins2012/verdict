import clsx from 'clsx'

interface ScoreRingProps {
  score: number
  size?: number
  label?: string
  className?: string
}

function scoreToColor(score: number): string {
  if (score >= 8) return '#4CAF7D'   // sage green
  if (score >= 6) return '#f59e0b'   // amber
  if (score >= 4) return '#E87D4B'   // orange
  return '#E05C5C'                    // red
}

export function ScoreRing({ score, size = 48, label, className }: ScoreRingProps) {
  const radius = 38
  const circumference = 2 * Math.PI * radius
  const progress = Math.max(0, Math.min(10, score)) / 10
  const dashOffset = circumference * (1 - progress)
  const color = scoreToColor(score)
  const fontSize = size < 44 ? 13 : size < 56 ? 15 : 18
  const strokeWidth = size < 44 ? 6 : 7

  return (
    <div className={clsx('flex flex-col items-center gap-0.5', className)}>
      <div style={{ width: size, height: size }} className="relative">
        <svg viewBox="0 0 100 100" width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          {/* Track */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke="#e8e4de"
            strokeWidth={strokeWidth}
          />
          {/* Progress */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 0.6s ease-out' }}
          />
        </svg>
        {/* Score number */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span style={{ fontSize, color }} className="font-display font-bold leading-none">
            {score}
          </span>
        </div>
      </div>
      {label && (
        <span className="text-xs text-ink-400 text-center leading-tight">{label}</span>
      )}
    </div>
  )
}
