// Public reads (docs/adr-generation-run.md D12). The only module public routes use for the catalog: it reads
// published decision nodes, approved node levers' snapshots, listed products and the published value copy.
// Candidates, unlisted products and unreviewed values never pass these queries.
import { z } from 'zod'
import { LeverInputFormat, LeverStatus, LeverType, NodeKind, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { loadTaxonomy, NodeRow, Taxonomy } from './taxonomy'
import { normalizeName } from './text'

export interface PublicLever {
  id: string
  definitionId: string
  position: number
  name: string
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  explanation: string
  allowedValues: string[]
}

const SnapshotSchema = z.object({
  name: z.string(), type: z.nativeEnum(LeverType), inputFormat: z.nativeEnum(LeverInputFormat), unit: z.string().nullable(),
  explanation: z.string(), allowedValues: z.array(z.string()),
})

/** The five published levers of a published decision node, in order, from their publish-time snapshots. */
export async function publicLevers(nodeId: string): Promise<PublicLever[]> {
  const rows = await prisma.nodeLever.findMany({
    where: { nodeId, status: LeverStatus.APPROVED, node: { publishedAt: { not: null } } },
    orderBy: { position: 'asc' },
    select: { id: true, definitionId: true, position: true, published: true },
  })
  return rows.flatMap((r) => {
    const snap = SnapshotSchema.safeParse(r.published)
    return snap.success && r.position !== null ? [{ id: r.id, definitionId: r.definitionId, position: r.position, ...snap.data }] : []
  })
}

const VALUE_SELECT = {
  definitionId: true, isUnknown: true, valueNumber: true, unit: true, valueText: true, valueBool: true, valueList: true,
  dimLengthIn: true, dimWidthIn: true, dimHeightIn: true, detail: true, evidenceQuote: true, sourceUrl: true, adminAttested: true,
} satisfies Prisma.PublishedLeverValueSelect

type PublishedValue = Prisma.PublishedLeverValueGetPayload<{ select: typeof VALUE_SELECT }>

export function presentPublished(v: PublishedValue | undefined) {
  if (!v || v.isUnknown) return { unknown: true as const }
  return {
    unknown: false as const,
    number: v.valueNumber, unit: v.unit, text: v.valueText, bool: v.valueBool, list: v.valueList,
    dimensions: v.dimLengthIn !== null && v.dimWidthIn !== null && v.dimHeightIn !== null
      ? { lengthIn: v.dimLengthIn, widthIn: v.dimWidthIn, heightIn: v.dimHeightIn } : null,
    detail: v.detail,
    evidence: { quote: v.evidenceQuote, url: v.sourceUrl, adminAttested: v.adminAttested },
  }
}

const crumbs = (t: Taxonomy, id: string) => t.path(id).map((n) => ({ slug: n.slug, name: n.name, visible: t.visible(n.id) }))

// ── Browse and search ───────────────────────────────────────────────────────────────────────────────
/** Visible nodes as a tree (roots first). */
export async function browse() {
  const t = await loadTaxonomy()
  const counts = await prisma.product.groupBy({ by: ['nodeId'], where: { listed: true }, _count: { _all: true } })
  const countOf = (id: string) => counts.find((c) => c.nodeId === id)?._count._all ?? 0
  const walk = (n: NodeRow, depth: number): unknown => ({
    slug: n.slug, name: n.name, kind: n.kind, productCount: n.kind === NodeKind.DECISION ? countOf(n.id) : undefined,
    children: depth > 4 ? [] : t.children(n.id).filter((c) => t.visible(c.node.id)).map((c) => walk(c.node, depth + 1)),
  })
  return t.nodes.filter((n) => n.parentId === null && t.visible(n.id)).map((n) => walk(n, 0))
}

/** Lower case, hyphens and underscores as spaces, single spaces. */
const searchKey = (s: string) => normalizeName(s.replace(/[-_]+/g, ' '))

/** Nodes first ("stroller", "car seat"), then listed products by name or brand. Unpublished matches say so. */
export async function search(q: string) {
  const needle = searchKey(q)
  if (needle.length < 2) return { nodes: [], products: [] }
  const t = await loadTaxonomy()
  const all = await prisma.taxonomyNode.findMany({ select: { id: true, name: true, slug: true, searchTerms: true, explainer: true, explainerApprovedAt: true } })
  const singular = needle.replace(/s\b/g, '')
  const hits = all.filter((n) => [n.name, n.slug, ...n.searchTerms].some((term) => {
    const k = searchKey(term)
    const ks = k.replace(/s\b/g, '')
    // "stroll" finds Strollers; "strollers for twins" finds Strollers too, but only on whole words.
    return k.includes(needle) || ks.includes(singular) || ` ${needle} `.includes(` ${k} `) || ` ${singular} `.includes(` ${ks} `)
  }))
  // Public nodes first, then names that start with the query, then the rest by name.
  const rank = (n: { id: string; name: string }) => (t.visible(n.id) ? 0 : 2) + (searchKey(n.name).startsWith(needle) || searchKey(n.name).startsWith(singular) ? 0 : 1)
  hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const nodes = hits.slice(0, 10).map((n) => {
    const row = t.byId.get(n.id)
    const visible = t.visible(n.id)
    return {
      slug: n.slug, name: n.name, kind: row?.kind ?? NodeKind.DECISION, published: visible,
      path: crumbs(t, n.id).map((c) => c.name),
      explainer: visible && row?.kind === NodeKind.NAVIGATION ? n.explainer : null,
      children: visible && row?.kind === NodeKind.NAVIGATION
        ? t.children(n.id).filter((c) => t.visible(c.node.id)).map((c) => ({ slug: c.node.slug, name: c.node.name, kind: c.node.kind })) : [],
    }
  })
  const products = await prisma.product.findMany({
    where: { listed: true, OR: [{ name: { contains: q.trim(), mode: 'insensitive' } }, { brand: { contains: q.trim(), mode: 'insensitive' } }] },
    take: 10, orderBy: { name: 'asc' },
    select: { id: true, name: true, brand: true, node: { select: { slug: true, name: true } } },
  })
  return { nodes, products }
}

// ── Node page ───────────────────────────────────────────────────────────────────────────────────────
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const filterSchema = z.object({
  min: z.preprocess(blank, z.coerce.number().finite().optional()),
  max: z.preprocess(blank, z.coerce.number().finite().optional()),
  in: z.preprocess(blank, z.string().max(500).optional()),
  has: z.preprocess(blank, z.string().max(120).optional()),
  is: z.preprocess(blank, z.enum(['yes', 'no']).optional()),
}).strict()

const filtersSchema = z.record(z.string().min(1).max(64), filterSchema).optional()

function filterClause(lever: PublicLever, f: z.infer<typeof filterSchema>): Prisma.ProductWhereInput | null {
  const given = Object.entries(f).filter(([, v]) => v !== undefined).map(([k]) => k)
  const allowed: Record<LeverType, string[]> = {
    MEASUREMENT: lever.inputFormat === LeverInputFormat.DIMENSIONS ? ['min', 'max', 'is'] : ['min', 'max'],
    CATEGORY: ['in'], COMPATIBILITY_LIST: ['has'], BOOLEAN: ['is'],
  }
  const bad = given.filter((k) => !allowed[lever.type].includes(k))
  if (bad.length > 0) throw new AppError(400, `Filter ${bad.join(', ')} does not apply to "${lever.name}"`)
  const value: Prisma.PublishedLeverValueWhereInput = { definitionId: lever.definitionId, isUnknown: false }
  switch (lever.type) {
    case LeverType.MEASUREMENT:
      if (f.min !== undefined || f.max !== undefined) value.valueNumber = { gte: f.min, lte: f.max }
      if (f.is !== undefined) value.valueBool = f.is === 'yes'
      break
    case LeverType.CATEGORY: {
      const wanted = (f.in ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const canonical = wanted.map((w) => lever.allowedValues.find((a) => a.toLowerCase() === w.toLowerCase()))
      if (canonical.some((c) => c === undefined)) throw new AppError(400, `"${lever.name}" values are: ${lever.allowedValues.join(', ')}`)
      if (canonical.length > 0) value.valueText = { in: canonical.filter((c): c is string => c !== undefined) }
      break
    }
    case LeverType.COMPATIBILITY_LIST:
      if (f.has) value.valueList = { has: f.has.trim() }
      break
    case LeverType.BOOLEAN:
      if (f.is !== undefined) value.valueBool = f.is === 'yes'
      break
  }
  const constrained = value.valueNumber !== undefined || value.valueBool !== undefined || value.valueText !== undefined || value.valueList !== undefined
  return constrained ? { publishedValues: { some: value } } : null
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100
}

export async function nodePage(slug: string, rawFilters: unknown) {
  const t = await loadTaxonomy()
  const node = t.bySlug(slug.trim().toLowerCase())
  if (!node || !t.visible(node.id)) throw new AppError(404, 'Not found')

  if (node.kind === NodeKind.NAVIGATION) {
    const row = await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: node.id }, select: { explainer: true, explainerChildLines: true } })
    const lines = (row.explainerChildLines && typeof row.explainerChildLines === 'object' && !Array.isArray(row.explainerChildLines)
      ? row.explainerChildLines : {}) as Record<string, unknown>
    const counts = await prisma.product.groupBy({ by: ['nodeId'], where: { listed: true }, _count: { _all: true } })
    return {
      kind: NodeKind.NAVIGATION, slug: node.slug, name: node.name, breadcrumbs: crumbs(t, node.id), explainer: row.explainer,
      children: t.children(node.id).filter((c) => t.visible(c.node.id)).map((c) => ({
        slug: c.node.slug, name: c.node.name, kind: c.node.kind, line: typeof lines[c.node.slug] === 'string' ? lines[c.node.slug] : null,
        productCount: c.node.kind === NodeKind.DECISION ? counts.find((x) => x.nodeId === c.node.id)?._count._all ?? 0 : null,
        alsoListed: c.viaSecondary,
      })),
    }
  }

  const levers = await publicLevers(node.id)
  const parsed = filtersSchema.safeParse(rawFilters)
  if (!parsed.success) throw new AppError(400, 'Invalid lever filter')
  const and: Prisma.ProductWhereInput[] = []
  for (const [leverId, f] of Object.entries(parsed.data ?? {})) {
    const lever = levers.find((l) => l.id === leverId)
    if (!lever) throw new AppError(400, 'Unknown lever in filter')
    const clause = filterClause(lever, f)
    if (clause) and.push(clause)
  }
  // The node's own listed products, plus listed products "also listed in" it (they show their own values).
  const inNode: Prisma.ProductWhereInput = { listed: true, OR: [{ nodeId: node.id }, { alsoListedIn: { some: { nodeId: node.id } } }] }
  const definitionIds = levers.map((l) => l.definitionId)
  const [products, total, all] = await Promise.all([
    prisma.product.findMany({
      where: { AND: [inNode, ...and] }, orderBy: { name: 'asc' }, take: 100,
      select: {
        id: true, name: true, brand: true, avgRatingLongterm: true, totalReviewCount: true, isDryRun: true, nodeId: true,
        publishedValues: { where: { definitionId: { in: definitionIds } }, select: VALUE_SELECT },
      },
    }),
    prisma.product.count({ where: inNode }),
    prisma.publishedLeverValue.findMany({ where: { nodeId: node.id, isUnknown: false }, select: { definitionId: true, valueNumber: true, valueList: true } }),
  ])
  const options: Record<string, { min: number; max: number } | { values: string[] }> = {}
  for (const l of levers) {
    const vals = all.filter((v) => v.definitionId === l.definitionId)
    if (l.type === LeverType.MEASUREMENT) {
      const nums = vals.map((v) => v.valueNumber).filter((n): n is number => n !== null)
      if (nums.length) options[l.id] = { min: Math.min(...nums), max: Math.max(...nums) }
    }
    if (l.type === LeverType.COMPATIBILITY_LIST) options[l.id] = { values: [...new Set(vals.flatMap((v) => v.valueList))].sort() }
  }
  return {
    kind: NodeKind.DECISION, slug: node.slug, name: node.name, breadcrumbs: crumbs(t, node.id),
    levers: levers.map((l) => ({ ...l, options: options[l.id] ?? null })),
    products: products.map((p) => ({
      id: p.id, name: p.name, brand: p.brand, avgRatingLongterm: p.avgRatingLongterm, totalReviewCount: p.totalReviewCount,
      isDryRun: p.isDryRun, alsoListed: p.nodeId !== node.id,
      values: Object.fromEntries(levers.map((l) => [l.id, presentPublished(p.publishedValues.find((v) => v.definitionId === l.definitionId))])),
    })),
    total,
    sort: 'name', // Best Fit and Top Rated arrive in Phase C
  }
}

/** A listed product's five published values, with the node's typical value (median) for measurements. */
export async function productLevers(productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { nodeId: true, listed: true } })
  if (!product?.nodeId || !product.listed) return []
  const levers = await publicLevers(product.nodeId)
  if (!levers.length) return []
  const [own, measured] = await Promise.all([
    prisma.publishedLeverValue.findMany({ where: { productId }, select: VALUE_SELECT }),
    prisma.publishedLeverValue.findMany({ where: { nodeId: product.nodeId, isUnknown: false, valueNumber: { not: null } }, select: { definitionId: true, valueNumber: true } }),
  ])
  return levers.map((lever) => ({
    lever,
    value: presentPublished(own.find((v) => v.definitionId === lever.definitionId)),
    typical: lever.type === LeverType.MEASUREMENT
      ? median(measured.filter((m) => m.definitionId === lever.definitionId).map((m) => m.valueNumber).filter((n): n is number => n !== null))
      : null,
  }))
}
