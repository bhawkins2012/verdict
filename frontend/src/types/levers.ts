// Value levers (docs/adr-levers.md). Shapes of the /api/categories, /api/products/:id and /api/admin responses.
export type LeverType = 'MEASUREMENT' | 'CATEGORY' | 'COMPATIBILITY_LIST' | 'BOOLEAN'
export type LeverInputFormat = 'SINGLE' | 'DIMENSIONS'
export type LeverStatus = 'CANDIDATE' | 'APPROVED' | 'RETIRED'

export interface PublicLever {
  id: string
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  explanation: string
  allowedValues: string[]
  position: number | null
}

export interface LeverValueSource {
  type: 'URL' | 'ADMIN_ENTERED'
  url: string | null
  label: string | null
}

export interface LeverValue {
  unknown: boolean
  number: number | null
  unit: string | null
  text: string | null
  bool: boolean | null
  list: string[]
  dimensions: { lengthIn: number; widthIn: number; heightIn: number } | null
  detail: string | null
  source: LeverValueSource
  isSample: boolean
  recordedAt: string
  recordedBy?: string | null
}

export interface ProductLever {
  lever: PublicLever
  value: LeverValue | null
  typical: number | null
}

export type FilterOptions = { min: number; max: number } | { values: string[] } | null

export interface CategoryPageData {
  category: { slug: string; name: string }
  levers: (PublicLever & { options: FilterOptions })[]
  products: {
    id: string
    name: string
    brand: string | null
    imageUrl: string | null
    avgRatingLongterm: number | null
    totalReviewCount: number
    values: Record<string, LeverValue>
  }[]
  totalInCategory: number
  sort: string
}

export interface CategorySearchHit {
  slug: string
  name: string
  published: boolean
}

export interface BrowseCategory {
  slug: string
  name: string
  productCount: number
}

/** One lever's filter as the API takes it: lever[<id>][min|max|in|has|is]. */
export interface LeverFilter {
  min?: number
  max?: number
  in?: string[]
  has?: string
  is?: 'yes' | 'no'
}

// ── Admin ────────────────────────────────────────────────────────────────────────────────────────────
export interface AdminRun {
  id: string
  mode: 'LIVE' | 'DRY_RUN'
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  model: string
  servedModel: string | null
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  costUsd: string | null
  createdAt: string
  finishedAt: string | null
  createdBy: string | null
  candidatesStored: number
}

export interface AdminLever {
  id: string
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  explanation: string
  relatedNeeds: string[]
  allowedValues: string[]
  status: LeverStatus
  position: number | null
  origin: 'GENERATED' | 'ADMIN'
  runId: string | null
  approvedBy: string | null
  approvedAt: string | null
  editedBy: string | null
  editedAt: string | null
  valueCount: number
  survey: { rank: number; respondents: number } | null
}

export interface AdminCategorySummary {
  id: string
  slug: string
  name: string
  searchTerms: string[]
  leversPublishedAt: string | null
  productCount: number
  approvedCount: number
  candidateCount: number
}

export interface AdminCategoryDetail {
  id: string
  slug: string
  name: string
  searchTerms: string[]
  leversPublishedAt: string | null
  leversPublishedBy: string | null
  levers: AdminLever[]
  runs: AdminRun[]
  survey: {
    id: string
    filename: string
    uploadedAt: string
    uploadedBy: string | null
    rowCount: number
    unmatched: { lever: string; rank: number; respondents: number }[]
  } | null
  products: { id: string; name: string; brand: string | null; valueCount: number }[]
}

export interface AdminConfig {
  mode: 'dry_run' | 'live'
  model: string
  dailyLimit: number
  maxTokens: number
}

export interface AdminProductLevers {
  product: { id: string; name: string; brand: string | null; category: { id: string; name: string; slug: string } | null }
  levers: (PublicLever & { value: LeverValue | null })[]
}
