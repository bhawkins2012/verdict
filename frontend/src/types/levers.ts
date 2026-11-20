// Catalog, levers and the generation run (docs/adr-generation-run.md). Shapes of /api/categories,
// /api/products/:id and /api/admin responses.
export type LeverType = 'MEASUREMENT' | 'CATEGORY' | 'COMPATIBILITY_LIST' | 'BOOLEAN'
export type LeverInputFormat = 'SINGLE' | 'DIMENSIONS'
export type LeverStatus = 'CANDIDATE' | 'APPROVED' | 'RETIRED'
export type NodeKind = 'NAVIGATION' | 'DECISION'
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface PublicLever {
  id: string
  definitionId: string
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  explanation: string
  allowedValues: string[]
  position: number | null
}

/** A published value with its evidence (public pages), or an explicit unknown. */
export type PublishedValue =
  | { unknown: true }
  | {
      unknown: false
      number: number | null
      unit: string | null
      text: string | null
      bool: boolean | null
      list: string[]
      dimensions: { lengthIn: number; widthIn: number; heightIn: number } | null
      detail: string | null
      evidence: { quote: string | null; url: string | null; adminAttested: boolean }
    }

/** A typed value as the admin API returns it. */
export interface TypedValue {
  unknown: boolean
  number: number | null
  unit: string | null
  text: string | null
  bool: boolean | null
  list: string[]
  dimensions: { lengthIn: number; widthIn: number; heightIn: number } | null
  detail: string | null
}

export interface ProductLever {
  lever: PublicLever
  value: PublishedValue
  typical: number | null
}

export type FilterOptions = { min: number; max: number } | { values: string[] } | null

export interface Crumb { slug: string; name: string; visible: boolean }

export interface DecisionPageData {
  kind: 'DECISION'
  slug: string
  name: string
  breadcrumbs: Crumb[]
  levers: (PublicLever & { options: FilterOptions })[]
  products: {
    id: string
    name: string
    brand: string | null
    avgRatingLongterm: number | null
    totalReviewCount: number
    isDryRun: boolean
    alsoListed: boolean
    values: Record<string, PublishedValue>
  }[]
  total: number
  sort: string
}

export interface NavigationPageData {
  kind: 'NAVIGATION'
  slug: string
  name: string
  breadcrumbs: Crumb[]
  explainer: string | null
  children: { slug: string; name: string; kind: NodeKind; line: string | null; productCount: number | null; alsoListed: boolean }[]
}

export type NodePageData = DecisionPageData | NavigationPageData

export interface SearchResult {
  nodes: {
    slug: string
    name: string
    kind: NodeKind
    published: boolean
    path: string[]
    explainer: string | null
    children: { slug: string; name: string; kind: NodeKind }[]
  }[]
  products: { id: string; name: string; brand: string | null; node: { slug: string; name: string } | null }[]
}

export interface BrowseNode {
  slug: string
  name: string
  kind: NodeKind
  productCount?: number
  children: BrowseNode[]
}

/** One lever's filter as the API takes it: lever[<id>][min|max|in|has|is]. */
export interface LeverFilter {
  min?: number
  max?: number
  in?: string[]
  has?: string
  is?: 'yes' | 'no'
}

// ── Admin ───────────────────────────────────────────────────────────────────────────────────────────
export interface AdminConfig {
  mode: 'dry_run' | 'live'
  model: string
  runCapUsd: number
  dailyCapUsd: number
  minProducts: number
  maxTokens: number
  leversPerNode: number
}

export interface AdminSummary { readyForReview: number; brandsToConfirm: number; unplacedProducts: number }

export type RunStatus = 'ACTIVE' | 'READY_FOR_REVIEW' | 'STALLED' | 'FAILED' | 'CANCELLED' | 'PUBLISHED'
export type StageName = 'PLACE' | 'LEVERS' | 'DISCOVER' | 'VERIFY' | 'EXTRACT' | 'EXPLAIN'
export type StageStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'STALLED'

export interface AdminTreeNode {
  id: string
  slug: string
  name: string
  kind: NodeKind
  depth: number
  publishedAt: string | null
  visible: boolean
  explainerApproved: boolean
  safetyCritical: boolean
  launchOrder: number | null
  latestRun: { id: string; status: RunStatus; kind: 'NODE' | 'EXPLAINER'; createdAt: string } | null
  products: { approved: number; needsAttention: number }
  levers: { candidates: number; approved: number }
  children: (AdminTreeNode & { viaSecondary: boolean })[]
  viaSecondary?: boolean
}

export interface AdminRun {
  id: string
  kind: 'NODE' | 'EXPLAINER'
  mode: 'LIVE' | 'DRY_RUN'
  status: RunStatus
  model: string
  capUsd: number
  estimateUsd: number | null
  costUsd: number
  warning: string | null
  error: string | null
  notes: string | null
  createdAt: string
  finishedAt: string | null
  readyAt: string | null
  createdBy: string | null
  stages: {
    stage: StageName
    status: StageStatus
    attempts: number
    startedAt: string | null
    heartbeatAt: string | null
    finishedAt: string | null
    error: string | null
    output: unknown
    calls: number
    costUsd: number
    inputTokens: number
    outputTokens: number
    webSearches: number
  }[]
  items: Partial<Record<'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'WAITING', number>>
}

export interface AdminNodeDetail {
  id: string
  slug: string
  name: string
  kind: NodeKind
  searchTerms: string[]
  safetyCritical: boolean
  ownSafetyCritical: boolean
  path: { id: string; slug: string; name: string }[]
  parentId: string | null
  secondaryParents: { id: string; slug: string; name: string }[]
  children: { id: string; slug: string; name: string; kind: NodeKind; viaSecondary: boolean }[]
  publishedAt: string | null
  publishedBy: string | null
  visible: boolean
  explainer: string | null
  explainerChildLines: Record<string, string> | null
  explainerApprovedAt: string | null
  explainerApprovedBy: string | null
  navigationParents: { id: string; slug: string; name: string }[]
  runs: AdminRun[]
  legacyRuns: { id: string; mode: string; status: string; model: string; error: string | null; costUsd: string | null; createdAt: string; output: unknown }[]
}

export type CatalogStatus = 'PROPOSED' | 'APPROVED' | 'NEEDS_ATTENTION' | 'REJECTED'

export interface ReviewProduct {
  id: string
  name: string
  brand: string | null
  url: string | null
  status: CatalogStatus
  approvedVia: 'AUTO' | 'ADMIN' | null
  attentionCheck: string | null
  attentionReason: string | null
  listed: boolean
  isDryRun: boolean
  reviewedBy: string | null
  item: {
    status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'WAITING'
    fetchOutcome: string | null
    httpStatus: number | null
    checks: Record<string, { pass: boolean; reason: string }> | null
    documents: { url: string; kind: string; outcome: string; chars?: number; detail?: string }[] | null
    error: string | null
  } | null
}

/** A lever card on the review screen's board (and the props the board needs). */
export interface BoardLever {
  id: string
  definitionId: string
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  explanation: string
  relatedNeeds: string[]
  allowedValues: string[]
  status: LeverStatus
  position: number | null
  origin: 'GENERATED' | 'ADMIN' | 'REFERENCE'
  note: string | null
  safety: boolean
  approvedBy: string | null
  approvedAt: string | null
  sharedWith: string[]
  coverage: { found: number; accepted: number; products: number }
  survey: { rank: number; respondents: number } | null
}

export type ValueStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED'

export interface ReviewValue {
  id: string
  productId: string
  definitionId: string
  status: ValueStatus
  origin: 'EXTRACTED' | 'MANUAL' | 'PHASE_A'
  value: TypedValue
  statedValue: string | null
  statedUnit: string | null
  quote: string | null
  sourceUrl: string | null
  confidence: Confidence | null
  unknownReason: string | null
  adminAttested: boolean
  attestedFetchOutcome: string | null
  edited: boolean
  originalValue: TypedValue | null
  acceptMode: 'SINGLE' | 'BULK' | null
  reviewedBy: string | null
  reviewedAt: string | null
  editedBy: string | null
}

export interface ReviewData {
  node: { id: string; slug: string; name: string; publishedAt: string | null; safetyCritical: boolean; path: string[] }
  config: { minProducts: number; mode: 'dry_run' | 'live' }
  run: AdminRun | null
  products: ReviewProduct[]
  levers: BoardLever[]
  values: ReviewValue[]
  progress: { products: Record<CatalogStatus, number>; values: { reviewed: number; total: number } }
}

export interface BrandDomainRow {
  id: string
  brand: string
  host: string
  status: 'VERIFIED' | 'PENDING_CONFIRMATION' | 'REJECTED'
  verifiedVia: 'AUTOMATIC' | 'ADMIN' | null
  verifiedAt: string | null
  verifiedBy: string | null
  checkResult: { failed?: string | null; siteNames?: string[]; labelContainsBrand?: boolean; homepage?: string } | null
  waitingProducts: string[]
}
