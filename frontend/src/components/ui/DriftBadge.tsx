import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import clsx from 'clsx'

interface DriftBadgeProps {
  drift: number
  size?: 'sm' | 'md' | 'lg'
}

export function DriftBadge({ drift, size = 'md' }: DriftBadgeProps) {
  const isPositive = drift > 0.5
  const isNegative = drift < -0.5
  const isNeutral = !isPositive && !isNegative

  const label = isPositive
    ? `+${drift.toFixed(1)}`
    : isNegative
      ? drift.toFixed(1)
      : '±0'

  const Icon = isPositive ? TrendingUp : isNegative ? TrendingDown : Minus

  const sizeClasses = {
    sm: 'px-1.5 py-0.5 text-xs gap-0.5',
    md: 'px-2 py-1 text-xs gap-1',
    lg: 'px-3 py-1.5 text-sm gap-1.5',
  }

  const iconSizes = { sm: 11, md: 12, lg: 14 }

  return (
    <span className={clsx(
      'inline-flex items-center rounded-full border font-medium',
      sizeClasses[size],
      isPositive && 'bg-sage-50 text-sage-700 border-sage-200',
      isNegative && 'bg-red-50 text-red-600 border-red-200',
      isNeutral && 'bg-ink-100 text-ink-500 border-ink-200',
    )}>
      <Icon size={iconSizes[size]} />
      {label}
    </span>
  )
}
