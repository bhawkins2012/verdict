import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { ReviewThread, Review, STAGE_LABELS, STAGE_ORDER } from '../types'
import { DriftBadge } from '../components/ui/DriftBadge'
import { ScoreRing } from '../components/ui/ScoreRing'
import { SurvivorshipChart } from '../components/reviews/SurvivorshipChart'
import { format } from 'date-fns'
import { Plus, ThumbsUp, ThumbsDown, ArrowLeft, TrendingDown, TrendingUp } from 'lucide-react'
import clsx from 'clsx'

export function ReviewThreadPage() {
  const { id: productId } = useParams<{ id: string }>()

  const { data: thread, isLoading } = useQuery<ReviewThread>({
    queryKey: ['thread', productId],
    queryFn: () => api.get(`/reviews/thread/${productId}`).then(r => r.data),
  })

  const { data: stats } = useQuery({
    queryKey: ['product-stats', productId],
    queryFn: () => api.get(`/reviews/product/${productId}/stats`).then(r => r.data),
  })

  if (isLoading) return <LoadingSkeleton />
  if (!thread) return null

  const sortedReviews = [...(thread.reviews || [])].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  )
  const completedStages = new Set(thread.stagesCompleted)
  const nextStage = STAGE_ORDER.find(s => !completedStages.has(s))

  const initialScore = sortedReviews[0]?.scoreOverall
  const latestScore = sortedReviews[sortedReviews.length - 1]?.scoreOverall

  return (
    <div className="p-8 max-w-3xl mx-auto animate-fade-in">
      {/* Back */}
      <Link to="/dashboard" className="btn-ghost flex items-center gap-2 mb-6 -ml-2 w-fit">
        <ArrowLeft size={16} /> Dashboard
      </Link>

      {/* Product header */}
      <div className="card p-6 mb-6">
        <div className="flex items-start gap-5">
          <div className="w-20 h-20 bg-ink-100 rounded-2xl shrink-0 overflow-hidden">
            {thread.product.imageUrl ? (
              <img src={thread.product.imageUrl} alt={thread.product.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-3xl text-ink-300 font-display">
                {thread.product.name[0]}
              </div>
            )}
          </div>
          <div className="flex-1">
            <p className="text-sm text-ink-400">{thread.product.brand}</p>
            <h2 className="font-display text-2xl text-ink-900">{thread.product.name}</h2>
            <p className="text-sm text-ink-500 capitalize mt-0.5">{thread.product.category}</p>

            <div className="flex items-center gap-3 mt-4">
              {sortedReviews.length >= 2 && (
                <>
                  <div className="flex items-center gap-2">
                    <ScoreRing score={initialScore} size={44} label="Initial" />
                    <div className="text-ink-300">→</div>
                    <ScoreRing score={latestScore} size={44} label="Latest" />
                  </div>
                  {thread.driftScore != null && (
                    <DriftBadge drift={thread.driftScore} size="lg" />
                  )}
                </>
              )}
              {sortedReviews.length === 1 && (
                <ScoreRing score={initialScore} size={52} label="Your score" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Survivorship chart (if product has multiple reviewers) */}
      {stats && stats.survivorshipCurve?.length >= 2 && (
        <div className="card p-6 mb-6">
          <h3 className="font-medium text-ink-800 mb-1">Community Opinion Over Time</h3>
          <p className="text-sm text-ink-400 mb-4">
            Average score across {stats.totalReviews} reviewers at each stage
          </p>
          <SurvivorshipChart data={stats.survivorshipCurve} />
          <div className="flex gap-6 mt-4 text-sm">
            {stats.wouldRecommendRate != null && (
              <div className="flex items-center gap-1.5 text-ink-500">
                <ThumbsUp size={14} className="text-sage-500" />
                <span><strong className="text-ink-800">{stats.wouldRecommendRate}%</strong> would recommend</span>
              </div>
            )}
            {stats.wouldStillBuyRate != null && (
              <div className="flex items-center gap-1.5 text-ink-500">
                <ThumbsUp size={14} className="text-amber-500" />
                <span><strong className="text-ink-800">{stats.wouldStillBuyRate}%</strong> would buy again</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="mb-6">
        <h3 className="font-medium text-ink-700 mb-4">Your Review Timeline</h3>
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-5 top-6 bottom-6 w-px bg-ink-200" />

          <div className="space-y-4">
            {sortedReviews.map((review, i) => (
              <ReviewCard
                key={review.id}
                review={review}
                previousScore={i > 0 ? sortedReviews[i - 1].scoreOverall : undefined}
                isLatest={i === sortedReviews.length - 1}
              />
            ))}

            {/* Next stage CTA */}
            {nextStage && (
              <div className="flex items-start gap-4 opacity-60">
                <div className="w-10 h-10 rounded-full border-2 border-dashed border-ink-300 flex items-center justify-center shrink-0 z-10 bg-ink-50">
                  <Plus size={16} className="text-ink-400" />
                </div>
                <Link
                  to={`/products/${productId}/review?stage=${nextStage}`}
                  className="card p-4 flex-1 border-dashed hover:border-amber-300 hover:bg-amber-50/50 transition-colors group"
                >
                  <p className="font-medium text-ink-600 group-hover:text-amber-700">
                    Write your {STAGE_LABELS[nextStage]} review
                  </p>
                  <p className="text-sm text-ink-400 mt-0.5">How has your opinion evolved?</p>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ReviewCard({ review, previousScore, isLatest }: {
  review: Review
  previousScore?: number
  isLatest: boolean
}) {
  const scoreDelta = previousScore != null ? review.scoreOverall - previousScore : null

  return (
    <div className="flex items-start gap-4">
      {/* Stage dot */}
      <div className={clsx(
        'w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 border-2',
        isLatest
          ? 'bg-ink-900 border-ink-900'
          : 'bg-white border-ink-300'
      )}>
        {isLatest
          ? <div className="w-2 h-2 bg-white rounded-full" />
          : <div className="w-2 h-2 bg-ink-300 rounded-full" />
        }
      </div>

      {/* Card */}
      <div className="card p-5 flex-1 animate-slide-up">
        <div className="flex items-start justify-between mb-3">
          <div>
            <span className={clsx(
              'stage-badge text-xs border',
              isLatest
                ? 'bg-ink-900 text-white border-ink-900'
                : 'bg-ink-100 text-ink-600 border-ink-200'
            )}>
              {STAGE_LABELS[review.stage]}
            </span>
            <p className="text-xs text-ink-400 mt-1">
              {format(new Date(review.capturedAt), 'MMM d, yyyy')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {scoreDelta != null && scoreDelta !== 0 && (
              <span className={clsx(
                'flex items-center gap-1 text-sm font-medium',
                scoreDelta > 0 ? 'text-sage-600' : 'text-red-500'
              )}>
                {scoreDelta > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {scoreDelta > 0 ? '+' : ''}{scoreDelta}
              </span>
            )}
            <ScoreRing score={review.scoreOverall} size={52} />
          </div>
        </div>

        {/* Score breakdown */}
        {(review.scoreValue || review.scoreQuality || review.scoreLongevity) && (
          <div className="flex gap-4 mb-3 pb-3 border-b border-ink-100">
            {[
              { label: 'Value', val: review.scoreValue },
              { label: 'Quality', val: review.scoreQuality },
              { label: 'Longevity', val: review.scoreLongevity },
            ].filter(s => s.val != null).map(({ label, val }) => (
              <div key={label} className="text-center">
                <div className="text-sm font-medium text-ink-700">{val}/10</div>
                <div className="text-xs text-ink-400">{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        {review.bodyText && (
          <p className="text-sm text-ink-700 mb-3 leading-relaxed">{review.bodyText}</p>
        )}

        {/* Pros/Cons */}
        {(review.pros?.length > 0 || review.cons?.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            {review.pros?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-sage-600 mb-1.5 flex items-center gap-1">
                  <ThumbsUp size={11} /> Pros
                </p>
                <ul className="space-y-0.5">
                  {review.pros.map((p, i) => (
                    <li key={i} className="text-xs text-ink-600">• {p}</li>
                  ))}
                </ul>
              </div>
            )}
            {review.cons?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-red-500 mb-1.5 flex items-center gap-1">
                  <ThumbsDown size={11} /> Cons
                </p>
                <ul className="space-y-0.5">
                  {review.cons.map((c, i) => (
                    <li key={i} className="text-xs text-ink-600">• {c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Would buy badges */}
        <div className="flex gap-2 mt-3">
          {review.wouldStillBuy != null && (
            <span className={clsx(
              'text-xs px-2 py-1 rounded-full border',
              review.wouldStillBuy ? 'bg-sage-50 text-sage-700 border-sage-200' : 'bg-red-50 text-red-600 border-red-200'
            )}>
              {review.wouldStillBuy ? '✓ Would still buy' : '✗ Wouldn\'t buy again'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="p-8 max-w-3xl mx-auto space-y-4">
      {[1,2,3].map(i => <div key={i} className="card h-32 animate-pulse bg-ink-100" />)}
    </div>
  )
}
