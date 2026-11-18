// Public category and product reads (docs/adr-levers.md D6). Levers come only from publicLevers().
import { z } from 'zod'
import { LeverInputFormat, LeverType, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from './candidates'
import { publicLevers, PublicLever } from './levers'
import { presentValue } from './values'

const VALUE_SELECT = {
  leverId: true, isUnknown: true, valueNumber: true, unit: true, valueText: true, valueBool: true, valueList: true,
  dimLengthIn: true, dimWidthIn: true, dimHeightIn: true, detail: true, sourceType: true, sourceUrl: true,
  sourceLabel: true, isSample: true, recordedAt: true,
} satisfies Prisma.ProductLeverValueSelect

/** Browse: only categories with published levers (ADR Q13). */
export async function browseCategories() {
  const categories = await prisma.category.findMany({
    where: { leversPublishedAt: { not: null } },
    orderBy: { name: 'asc' },
    select: { slug: true, name: true, _count: { select: { products: true } } },
  })
  return categories.map((c) => ({ slug: c.slug, name: c.name, productCount: c._count.products }))
}

/**
 * Search matches categories by name, slug or search term. Unpublished matches are returned too, without a
 * link target, so the UI can say the category is being prepared (product spec, "Search").
 */
/** Lower case, hyphens and underscores as spaces, single spaces. */
const searchKey = (s: string) => normalizeName(s.replace(/[-_]+/g, ' '))

export async function searchCategories(q: string) {
  const needle = searchKey(q)
  if (needle.length < 2) return []
  const all = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: { slug: true, name: true, searchTerms: true, leversPublishedAt: true },
  })
  const hits = all.filter((c) =>
    [c.name, c.slug, ...c.searchTerms].some((t) => {
      const term = searchKey(t)
      // "stroll" finds Strollers; "strollers for twins" finds Strollers too, but only on whole words.
      return term.includes(needle) || ` ${needle} `.includes(` ${term} `)
    })
  )
  return hits.slice(0, 10).map((c) => ({ slug: c.slug, name: c.name, published: c.leversPublishedAt !== null }))
}

// ── Category page ────────────────────────────────────────────────────────────────────────────────────
const filterSchema = z
  .object({
    min: z.coerce.number().finite().optional(),
    max: z.coerce.number().finite().optional(),
    in: z.string().max(500).optional(),
    has: z.string().max(120).optional(),
    is: z.enum(['yes', 'no']).optional(),
  })
  .strict()

const filtersSchema = z.record(z.string().min(1).max(64), filterSchema).optional()

type Filters = z.infer<typeof filtersSchema>

function filterClause(lever: PublicLever, f: z.infer<typeof filterSchema>): Prisma.ProductWhereInput {
  const given = Object.entries(f).filter(([, v]) => v !== undefined).map(([k]) => k)
  const allowed: Record<LeverType, string[]> = {
    MEASUREMENT: lever.inputFormat === LeverInputFormat.DIMENSIONS ? ['min', 'max', 'is'] : ['min', 'max'],
    CATEGORY: ['in'],
    COMPATIBILITY_LIST: ['has'],
    BOOLEAN: ['is'],
  }
  const bad = given.filter((k) => !allowed[lever.type].includes(k))
  if (bad.length > 0) throw new AppError(400, `Filter ${bad.join(', ')} does not apply to "${lever.name}"`)
  const value: Prisma.ProductLeverValueWhereInput = { leverId: lever.id, isUnknown: false }
  switch (lever.type) {
    case LeverType.MEASUREMENT:
      if (f.min !== undefined || f.max !== undefined) value.valueNumber = { gte: f.min, lte: f.max }
      if (f.is !== undefined) value.valueBool = f.is === 'yes' // one-hand fold, for a dimensions lever
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
  return { leverValues: { some: value } }
}

export async function categoryPage(slug: string, rawFilters: unknown) {
  const category = await prisma.category.findUnique({
    where: { slug: slug.trim().toLowerCase() },
    select: { id: true, slug: true, name: true, leversPublishedAt: true },
  })
  // Hidden from browse until its levers are published (ADR Q13).
  if (!category || !category.leversPublishedAt) throw new AppError(404, 'Category not found')
  const levers = await publicLevers(category.id)

  const parsed = filtersSchema.safeParse(rawFilters)
  if (!parsed.success) throw new AppError(400, 'Invalid lever filter')
  const filters: Filters = parsed.data
  const and: Prisma.ProductWhereInput[] = []
  for (const [leverId, f] of Object.entries(filters ?? {})) {
    const lever = levers.find((l) => l.id === leverId)
    if (!lever) throw new AppError(400, 'Unknown lever in filter')
    and.push(filterClause(lever, f))
  }

  const leverIds = levers.map((l) => l.id)
  const [products, total, options] = await Promise.all([
    prisma.product.findMany({
      where: { categoryId: category.id, AND: and },
      orderBy: { name: 'asc' },
      take: 100,
      select: {
        id: true, name: true, brand: true, imageUrl: true, avgRatingLongterm: true, totalReviewCount: true,
        leverValues: { where: { leverId: { in: leverIds } }, select: VALUE_SELECT },
      },
    }),
    prisma.product.count({ where: { categoryId: category.id } }),
    filterOptions(levers),
  ])
  return {
    category: { slug: category.slug, name: category.name },
    levers: levers.map((l) => ({ ...l, options: options[l.id] ?? null })),
    products: products.map((p) => ({
      id: p.id, name: p.name, brand: p.brand, imageUrl: p.imageUrl, avgRatingLongterm: p.avgRatingLongterm,
      totalReviewCount: p.totalReviewCount,
      values: Object.fromEntries(p.leverValues.map((v) => [v.leverId, presentValue(v)])),
    })),
    totalInCategory: total,
    sort: 'name', // Best Fit and Top Rated arrive in Phase C
  }
}

/** Ranges for measurements and the known values for compatibility lists, to build the filter controls. */
async function filterOptions(levers: PublicLever[]) {
  const out: Record<string, { min: number; max: number } | { values: string[] }> = {}
  const measured = levers.filter((l) => l.type === LeverType.MEASUREMENT).map((l) => l.id)
  if (measured.length > 0) {
    const ranges = await prisma.productLeverValue.groupBy({
      by: ['leverId'],
      where: { leverId: { in: measured }, isUnknown: false, valueNumber: { not: null } },
      _min: { valueNumber: true },
      _max: { valueNumber: true },
    })
    for (const r of ranges) {
      if (r._min.valueNumber !== null && r._max.valueNumber !== null) out[r.leverId] = { min: r._min.valueNumber, max: r._max.valueNumber }
    }
  }
  for (const l of levers.filter((x) => x.type === LeverType.COMPATIBILITY_LIST)) {
    const rows = await prisma.productLeverValue.findMany({ where: { leverId: l.id, isUnknown: false }, select: { valueList: true } })
    out[l.id] = { values: [...new Set(rows.flatMap((r) => r.valueList))].sort() }
  }
  return out
}

// ── Product page ─────────────────────────────────────────────────────────────────────────────────────
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100
}

/** Lever values for one product, with the category typical value (median) for measurements. */
export async function productLevers(productId: string, categoryId: string | null) {
  if (!categoryId) return []
  const levers = await publicLevers(categoryId)
  if (levers.length === 0) return []
  const leverIds = levers.map((l) => l.id)
  const [own, measured] = await Promise.all([
    prisma.productLeverValue.findMany({ where: { productId, leverId: { in: leverIds } }, select: VALUE_SELECT }),
    prisma.productLeverValue.findMany({
      where: { leverId: { in: levers.filter((l) => l.type === LeverType.MEASUREMENT).map((l) => l.id) }, isUnknown: false, valueNumber: { not: null }, product: { categoryId } },
      select: { leverId: true, valueNumber: true },
    }),
  ])
  return levers.map((lever) => {
    const v = own.find((o) => o.leverId === lever.id)
    const numbers = measured.filter((m) => m.leverId === lever.id).map((m) => m.valueNumber).filter((n): n is number => n !== null)
    return {
      lever,
      value: v ? presentValue(v) : null,
      typical: lever.type === LeverType.MEASUREMENT ? median(numbers) : null,
    }
  })
}
