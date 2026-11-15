export type ReviewStage =
  | 'INITIAL'
  | 'ONE_WEEK'
  | 'TWO_WEEKS'
  | 'ONE_MONTH'
  | 'THREE_MONTHS'
  | 'SIX_MONTHS'
  | 'ONE_YEAR'
  | 'TWO_YEARS'
  | 'CUSTOM'

export const STAGE_LABELS: Record<ReviewStage, string> = {
  INITIAL: 'First Impression',
  ONE_WEEK: '1 Week Later',
  TWO_WEEKS: '2 Weeks Later',
  ONE_MONTH: '1 Month Later',
  THREE_MONTHS: '3 Months Later',
  SIX_MONTHS: '6 Months Later',
  ONE_YEAR: '1 Year Later',
  TWO_YEARS: '2 Years Later',
  CUSTOM: 'Custom',
}

// Stage order and the nudge cadence come from the API (GET /api/config, see lib/stages.ts), never from
// a list here.

export interface Review {
  id: string
  threadId: string
  stage: ReviewStage
  capturedAt: string
  source: 'NATIVE' | 'IMPORTED'
  scoreOverall: number
  scoreValue?: number
  scoreQuality?: number
  scoreLongevity?: number
  scoreExpectations?: number
  bodyText?: string
  pros: string[]
  cons: string[]
  wouldStillBuy?: boolean
  wouldRecommend?: boolean
  sentimentScore?: number
  keyTopics: string[]
}

export interface ReviewThread {
  id: string
  userId: string
  productId: string
  startedAt: string
  updatedAt: string
  driftScore?: number
  stagesCompleted: ReviewStage[]
  product: Product
  reviews: Review[]
  nudges?: Nudge[]
  _count?: { reviews: number }
  /** GET /reviews/thread/:productId only: the backend planner's next check-in (null when there is none). */
  nextCheckIn?: { stage: ReviewStage; dueAt: string } | null
}

export interface Product {
  id: string
  name: string
  brand?: string
  category: string
  subcategory?: string
  description?: string
  imageUrl?: string
  websiteUrl?: string
  priceTier?: 'BUDGET' | 'MID_RANGE' | 'PREMIUM' | 'LUXURY'
  attributes?: Record<string, unknown>
  avgRatingInitial?: number
  avgRatingLongterm?: number
  driftScoreAvg?: number
  totalReviewCount: number
}

export interface Nudge {
  id: string
  userId: string
  threadId: string
  targetStage: ReviewStage
  scheduledFor: string // due date
  sendAt?: string
  sentAt?: string
  status: 'PENDING' | 'SENDING' | 'SENT' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'FAILED'
  channel?: 'EMAIL' | 'IN_APP' | null
  snoozedUntil?: string | null
  snoozeCount?: number
  thread?: ReviewThread
}

export interface Recommendation {
  productId: string
  score: number
  reason: string
  confidence: number
  demographicMatch: number
  product: Product
  isFallback?: boolean
}

export interface ProductStats {
  totalReviews: number
  survivorshipCurve: Array<{
    stage: ReviewStage
    avgScore: number
    count: number
  }>
  wouldRecommendRate?: number
  wouldStillBuyRate?: number
}
