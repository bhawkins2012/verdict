import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Product, ReviewThread } from '../types'
import { DriftBadge } from '../components/ui/DriftBadge'
import { SurvivorshipChart } from '../components/reviews/SurvivorshipChart'
import { ArrowLeft, Star, ExternalLink, Plus } from 'lucide-react'

export function ProductPage() {
  const { id } = useParams<{ id: string }>()

  const { data: product } = useQuery<Product>({
    queryKey: ['product', id],
    queryFn: () => api.get(`/products/${id}`).then(r => r.data),
  })

  const { data: stats } = useQuery({
    queryKey: ['product-stats', id],
    queryFn: () => api.get(`/reviews/product/${id}/stats`).then(r => r.data),
    enabled: !!id,
  })

  const { data: thread } = useQuery<ReviewThread>({
    queryKey: ['thread', id],
    queryFn: () => api.get(`/reviews/thread/${id}`).then(r => r.data),
    retry: false,
  })

  if (!product) return null

  const hasThread = !!thread
  const priceTierLabel = { BUDGET: '$ Budget', MID_RANGE: '$$ Mid-range', PREMIUM: '$$$ Premium', LUXURY: '$$$$ Luxury' }

  return (
    <div className="p-8 max-w-3xl mx-auto animate-fade-in">
      <Link to="/discover" className="btn-ghost flex items-center gap-2 mb-6 -ml-2 w-fit">
        <ArrowLeft size={16} /> Discover
      </Link>

      <div className="card p-6 mb-6">
        <div className="flex gap-5">
          <div className="w-24 h-24 bg-ink-100 rounded-2xl shrink-0">
            {product.imageUrl
              ? <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover rounded-2xl" />
              : <div className="w-full h-full flex items-center justify-center text-4xl text-ink-200 font-display">{product.name[0]}</div>
            }
          </div>
          <div className="flex-1">
            <p className="text-sm text-ink-400">{product.brand}</p>
            <h2 className="font-display text-2xl text-ink-900">{product.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-ink-400 capitalize bg-ink-100 px-2 py-0.5 rounded-full">{product.category}</span>
              {product.priceTier && (
                <span className="text-xs text-ink-400">{priceTierLabel[product.priceTier]}</span>
              )}
            </div>
            {product.description && <p className="text-sm text-ink-600 mt-3 leading-relaxed">{product.description}</p>}
          </div>
        </div>

        <div className="flex items-center gap-6 mt-6 pt-6 border-t border-ink-100">
          {product.avgRatingInitial != null && (
            <div><div className="text-2xl font-display text-ink-900">{product.avgRatingInitial.toFixed(1)}</div>
            <div className="text-xs text-ink-400">Avg initial</div></div>
          )}
          {product.avgRatingLongterm != null && (
            <div><div className="text-2xl font-display text-ink-900">{product.avgRatingLongterm.toFixed(1)}</div>
            <div className="text-xs text-ink-400">Avg long-term</div></div>
          )}
          {product.driftScoreAvg != null && <DriftBadge drift={product.driftScoreAvg} size="lg" />}
          <span className="text-sm text-ink-400 ml-auto">{product.totalReviewCount} reviews</span>
        </div>
      </div>

      {stats?.survivorshipCurve?.length >= 2 && (
        <div className="card p-6 mb-6">
          <h3 className="font-medium text-ink-800 mb-4">Community Opinion Over Time</h3>
          <SurvivorshipChart data={stats.survivorshipCurve} />
        </div>
      )}

      <div className="flex gap-3">
        {hasThread ? (
          <Link to={`/products/${id}/thread`} className="btn-primary flex items-center gap-2 flex-1 justify-center">
            <Star size={15} /> View my review thread
          </Link>
        ) : (
          <Link to={`/products/${id}/review`} className="btn-primary flex items-center gap-2 flex-1 justify-center">
            <Plus size={15} /> Write first impression
          </Link>
        )}
      </div>
    </div>
  )
}
