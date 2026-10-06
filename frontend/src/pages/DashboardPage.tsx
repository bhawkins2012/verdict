import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { ReviewThread, ReviewStage, Nudge, STAGE_LABELS } from '../types'
import { useAuthStore } from '../store/authStore'
import { DriftBadge } from '../components/ui/DriftBadge'
import { ScoreRing } from '../components/ui/ScoreRing'
import { formatDistanceToNow } from 'date-fns'
import { ArrowRight, Clock, CheckCircle2, Sparkles, Plus } from 'lucide-react'
import clsx from 'clsx'

const TRACKED_STAGES: ReviewStage[] = ['INITIAL', 'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR']

export function DashboardPage() {
  const { user } = useAuthStore()
  const [searchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'reviews'

  const { data: threads, isLoading: threadsLoading } = useQuery<ReviewThread[]>({
    queryKey: ['threads'],
    queryFn: () => api.get('/reviews/threads').then(r => r.data),
  })

  const { data: nudges, isLoading: nudgesLoading } = useQuery<Nudge[]>({
    queryKey: ['nudges'],
    queryFn: () => api.get('/nudges').then(r => r.data),
  })

  const { data: stats } = useQuery({
    queryKey: ['user-stats'],
    queryFn: () => api.get('/users/me/stats').then(r => r.data),
  })

  return (
    <div className="p-8 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <h2 className="font-display text-3xl text-ink-900">
          Good to see you, {user?.displayName?.split(' ')[0] || user?.username}.
        </h2>
        <p className="text-ink-500 mt-1">Track your evolving opinions.</p>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Products Tracked', value: stats.threadCount },
            { label: 'Reviews Written', value: stats.reviewCount },
            { label: 'Pending Check-ins', value: stats.pendingNudges, accent: true },
          ].map(({ label, value, accent }) => (
            <div key={label} className={clsx('card p-5', accent && value > 0 && 'border-amber-300 bg-amber-50')}>
              <div className={clsx('text-3xl font-display', accent && value > 0 ? 'text-amber-700' : 'text-ink-900')}>
                {value}
              </div>
              <div className="text-sm text-ink-500 mt-1">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Nudges callout */}
      {nudges && nudges.length > 0 && (
        <div className="card border-amber-300 bg-gradient-to-r from-amber-50 to-white p-5 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-amber-400 rounded-xl flex items-center justify-center">
              <Clock size={20} className="text-white" />
            </div>
            <div>
              <p className="font-medium text-ink-900">
                {nudges.length} product{nudges.length !== 1 ? 's' : ''} waiting for your update
              </p>
              <p className="text-sm text-ink-500">Share how your opinion has evolved</p>
            </div>
          </div>
          <Link to="?tab=nudges" className="btn-primary flex items-center gap-2">
            Review now <ArrowRight size={15} />
          </Link>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-ink-100 p-1 rounded-xl w-fit">
        {[
          { id: 'reviews', label: 'My Reviews' },
          { id: 'nudges', label: `Check-ins ${nudges?.length ? `(${nudges.length})` : ''}` },
        ].map(tab => (
          <Link
            key={tab.id}
            to={`?tab=${tab.id}`}
            className={clsx(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              activeTab === tab.id
                ? 'bg-white text-ink-900 shadow-sm'
                : 'text-ink-500 hover:text-ink-700'
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Reviews tab */}
      {activeTab === 'reviews' && (
        <div>
          {threadsLoading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => <div key={i} className="card h-24 animate-pulse bg-ink-100" />)}
            </div>
          ) : threads?.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-3">
              {threads?.map(thread => (
                <ThreadCard key={thread.id} thread={thread} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Nudges tab */}
      {activeTab === 'nudges' && (
        <div>
          {nudgesLoading ? (
            <div className="space-y-3">
              {[1,2].map(i => <div key={i} className="card h-24 animate-pulse bg-ink-100" />)}
            </div>
          ) : nudges?.length === 0 ? (
            <div className="card p-12 text-center">
              <CheckCircle2 size={40} className="mx-auto text-sage-400 mb-3" />
              <p className="font-medium text-ink-700">All caught up!</p>
              <p className="text-sm text-ink-400 mt-1">No check-ins pending right now.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {nudges?.map(nudge => (
                <NudgeCard key={nudge.id} nudge={nudge} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThreadCard({ thread }: { thread: ReviewThread }) {
  const latestReview = thread.reviews?.[0]
  const stageCount = thread.stagesCompleted?.length || 0

  return (
    <Link
      to={`/products/${thread.product.id}/thread`}
      className="card p-5 flex items-center gap-5 hover:shadow-md transition-shadow group"
    >
      {/* Product image / placeholder */}
      <div className="w-14 h-14 bg-ink-100 rounded-xl shrink-0 overflow-hidden">
        {thread.product.imageUrl ? (
          <img src={thread.product.imageUrl} alt={thread.product.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-ink-400 font-display text-xl">
            {thread.product.name[0]}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium text-ink-900 group-hover:text-ink-700 truncate">
              {thread.product.name}
            </p>
            <p className="text-sm text-ink-400">
              {thread.product.brand} · {stageCount} review{stageCount !== 1 ? 's' : ''}
              {thread.updatedAt && ` · Updated ${formatDistanceToNow(new Date(thread.updatedAt))} ago`}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {latestReview && <ScoreRing score={latestReview.scoreOverall} size={44} />}
            {thread.driftScore != null && <DriftBadge drift={thread.driftScore} />}
          </div>
        </div>

        {/* Stage progress */}
        <div className="flex gap-1 mt-3">
          {TRACKED_STAGES.map(stage => (
            <div
              key={stage}
              className={clsx(
                'h-1.5 rounded-full flex-1',
                thread.stagesCompleted?.includes(stage)
                  ? 'bg-ink-800'
                  : 'bg-ink-200'
              )}
            />
          ))}
        </div>
      </div>

      <ArrowRight size={16} className="text-ink-300 group-hover:text-ink-600 transition-colors shrink-0" />
    </Link>
  )
}

function NudgeCard({ nudge }: { nudge: Nudge }) {
  const product = nudge.thread?.product

  return (
    <div className="card p-5 flex items-center gap-5 border-amber-200 bg-amber-50/50">
      <div className="w-10 h-10 bg-amber-400 rounded-xl flex items-center justify-center shrink-0">
        <Clock size={18} className="text-white" />
      </div>
      <div className="flex-1">
        <p className="font-medium text-ink-900">
          Time for your <span className="text-amber-700">{STAGE_LABELS[nudge.targetStage]}</span> review
        </p>
        <p className="text-sm text-ink-500">{product?.name}</p>
      </div>
      <Link
        to={`/products/${product?.id}/review?stage=${nudge.targetStage}&nudgeId=${nudge.id}`}
        className="btn-primary text-sm flex items-center gap-2"
      >
        Write review <ArrowRight size={14} />
      </Link>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="card p-16 text-center">
      <Sparkles size={40} className="mx-auto text-amber-400 mb-4" />
      <h3 className="font-display text-xl text-ink-800 mb-2">Start your first review</h3>
      <p className="text-ink-500 text-sm mb-6 max-w-sm mx-auto">
        Discover products, write your first impression, and Verdict will remind you to check back in.
      </p>
      <Link to="/discover" className="btn-primary inline-flex items-center gap-2">
        <Plus size={16} /> Discover products
      </Link>
    </div>
  )
}
