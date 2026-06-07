import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Recommendation } from '../types'
import { DriftBadge } from '../components/ui/DriftBadge'
import { ScoreRing } from '../components/ui/ScoreRing'
import { TrendingUp, Sparkles, ArrowRight, UserCheck } from 'lucide-react'
import clsx from 'clsx'

export function RecommendationsPage() {
  const { data, isLoading } = useQuery<{ recommendations: Recommendation[]; isFallback?: boolean }>({
    queryKey: ['recommendations'],
    queryFn: () => api.get('/recommendations').then(r => r.data),
  })

  const recs = data?.recommendations || []

  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
            <Sparkles size={20} className="text-amber-600" />
          </div>
          <h2 className="font-display text-3xl text-ink-900">For You</h2>
        </div>
        <p className="text-ink-500">
          {data?.isFallback
            ? 'Popular products with strong long-term ratings'
            : 'Personalized based on users with your profile and taste'
          }
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="card h-48 animate-pulse bg-ink-100" />)}
        </div>
      ) : recs.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {recs.map((rec, i) => (
            <RecommendationCard key={rec.productId} rec={rec} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function RecommendationCard({ rec, rank }: { rec: Recommendation; rank: number }) {
  const product = rec.product
  if (!product) return null

  return (
    <Link
      to={`/products/${product.id}`}
      className="card p-5 hover:shadow-md transition-shadow group flex flex-col gap-4"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 bg-ink-100 rounded-xl shrink-0 overflow-hidden">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-ink-400 font-display text-lg">
              {product.name[0]}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-ink-900 truncate group-hover:text-ink-700">{product.name}</p>
          <p className="text-xs text-ink-400">{product.brand} · <span className="capitalize">{product.category}</span></p>
        </div>
        <span className="text-xs text-ink-400 font-mono">#{rank}</span>
      </div>

      {/* Scores */}
      <div className="flex items-center gap-3">
        {product.avgRatingInitial != null && (
          <div className="text-center">
            <div className="text-lg font-display text-ink-800">{product.avgRatingInitial.toFixed(1)}</div>
            <div className="text-xs text-ink-400">Initial</div>
          </div>
        )}
        {product.avgRatingLongterm != null && (
          <>
            <div className="text-ink-300 text-sm">→</div>
            <div className="text-center">
              <div className="text-lg font-display text-ink-800">{product.avgRatingLongterm.toFixed(1)}</div>
              <div className="text-xs text-ink-400">Long-term</div>
            </div>
          </>
        )}
        {product.driftScoreAvg != null && (
          <DriftBadge drift={product.driftScoreAvg} />
        )}
      </div>

      {/* Reason */}
      <div className={clsx(
        'flex items-start gap-2 p-3 rounded-xl text-xs',
        rec.demographicMatch > 0.6
          ? 'bg-sage-50 text-sage-700'
          : 'bg-amber-50 text-amber-700'
      )}>
        {rec.demographicMatch > 0.6
          ? <UserCheck size={13} className="shrink-0 mt-0.5" />
          : <TrendingUp size={13} className="shrink-0 mt-0.5" />
        }
        {rec.reason}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto">
        <span className="text-xs text-ink-400">
          {product.totalReviewCount} review{product.totalReviewCount !== 1 ? 's' : ''}
        </span>
        <ArrowRight size={14} className="text-ink-300 group-hover:text-ink-600 transition-colors" />
      </div>
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="card p-16 text-center">
      <Sparkles size={40} className="mx-auto text-amber-400 mb-4" />
      <h3 className="font-display text-xl text-ink-800 mb-2">Personalizing your feed</h3>
      <p className="text-ink-500 text-sm mb-6 max-w-sm mx-auto">
        Write a few reviews and complete your profile to get personalized recommendations.
      </p>
      <div className="flex gap-3 justify-center">
        <Link to="/profile" className="btn-secondary">Complete profile</Link>
        <Link to="/discover" className="btn-primary">Discover products</Link>
      </div>
    </div>
  )
}
