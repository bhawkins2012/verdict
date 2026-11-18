// CSV imports (docs/adr-levers.md D5, D7): survey rankings and product lever values. Both are all or
// nothing: every row is validated first, any error returns the row numbers, and nothing is written.
import { parse } from 'csv-parse/sync'
import { LeverInputFormat, LeverStatus, LeverType, ValueSourceType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from './candidates'
import { LeverValueInput, leverValueInputSchema, toValueData, ValueData } from './values'

export const MAX_CSV_ROWS = 2000

export class CsvRowsError extends AppError {
  constructor(public rows: { row: number; error: string }[]) {
    super(400, `The file has ${rows.length} invalid row${rows.length === 1 ? '' : 's'}; nothing was imported`, { rows })
  }
}

/** Parse CSV text with a header row into records keyed by lower-cased header. */
export function parseCsv(text: string, required: readonly string[]): Record<string, string>[] {
  let records: Record<string, string>[]
  try {
    records = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    })
  } catch (err) {
    throw new AppError(400, `Not a valid CSV file: ${err instanceof Error ? err.message.slice(0, 200) : 'parse error'}`)
  }
  if (records.length === 0) throw new AppError(400, 'The file has no data rows')
  if (records.length > MAX_CSV_ROWS) throw new AppError(400, `At most ${MAX_CSV_ROWS} rows per file`)
  const missing = required.filter((c) => !(c in records[0]))
  if (missing.length > 0) throw new AppError(400, `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
  return records
}

/** Row numbers as a spreadsheet shows them: the header is row 1. */
const rowNumber = (index: number) => index + 2

// ── Survey ───────────────────────────────────────────────────────────────────────────────────────────
export const SURVEY_COLUMNS = ['lever', 'rank', 'respondents'] as const

export async function importSurvey(categoryId: string, filename: string, text: string, userId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
  if (!category) throw new AppError(404, 'Category not found')
  const records = parseCsv(text, SURVEY_COLUMNS)
  const errors: { row: number; error: string }[] = []
  const rows: { leverName: string; rank: number; respondentCount: number }[] = []
  const seen = new Set<string>()
  records.forEach((r, i) => {
    const name = r.lever ?? ''
    const rank = Number(r.rank)
    const respondents = Number(r.respondents)
    if (name.length < 1 || name.length > 60) errors.push({ row: rowNumber(i), error: 'lever must be 1 to 60 characters' })
    else if (seen.has(normalizeName(name))) errors.push({ row: rowNumber(i), error: `duplicate lever "${name}"` })
    else if (!Number.isInteger(rank) || rank < 1) errors.push({ row: rowNumber(i), error: 'rank must be a whole number from 1' })
    else if (!Number.isInteger(respondents) || respondents < 0) errors.push({ row: rowNumber(i), error: 'respondents must be a whole number from 0' })
    else rows.push({ leverName: name, rank, respondentCount: respondents })
    seen.add(normalizeName(name))
  })
  if (errors.length > 0) throw new CsvRowsError(errors)
  return prisma.surveyImport.create({
    data: { categoryId, filename, uploadedById: userId, rowCount: rows.length, rankings: { create: rows } },
    include: { rankings: { orderBy: { rank: 'asc' } } },
  })
}

// ── Lever values ─────────────────────────────────────────────────────────────────────────────────────
export const VALUE_COLUMNS = ['product_id', 'lever', 'value', 'source'] as const
const ADMIN_SOURCE = 'entered by admin'

function yesNo(v: string | undefined): boolean | undefined | 'invalid' {
  if (v === undefined || v === '') return undefined
  const s = v.toLowerCase()
  if (['yes', 'y', 'true', '1'].includes(s)) return true
  if (['no', 'n', 'false', '0'].includes(s)) return false
  return 'invalid'
}

interface ImportLever { id: string; name: string; type: LeverType; inputFormat: LeverInputFormat; unit: string | null; allowedValues: string[] }

/** One CSV row → the same input the admin form sends, or an error. */
export function rowToInput(r: Record<string, string>, lever: ImportLever): LeverValueInput | string {
  const sourceText = r.source ?? ''
  if (!sourceText) return `source is required: a URL or "${ADMIN_SOURCE}"`
  const source = sourceText.toLowerCase() === ADMIN_SOURCE
    ? { type: ValueSourceType.ADMIN_ENTERED }
    : { type: ValueSourceType.URL, url: sourceText }
  const unknown = yesNo(r.unknown)
  if (unknown === 'invalid') return 'unknown must be yes or no'
  const common = {
    source,
    detail: r.detail || undefined,
    sourceLabel: r.source_label || undefined,
  }
  if (unknown) return leverInput({ ...common, unknown: true })
  const value = r.value ?? ''
  if (!value) return 'value is required (or set unknown to yes)'
  const unit = r.unit || undefined

  switch (lever.type) {
    case LeverType.MEASUREMENT: {
      if (lever.inputFormat === LeverInputFormat.DIMENSIONS) {
        const m = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(value)
        if (!m) return 'value must be folded L x W x H in inches, for example 22 x 18 x 9'
        const oneHand = yesNo(r.one_hand_fold)
        if (oneHand === 'invalid') return 'one_hand_fold must be yes or no'
        return leverInput({
          ...common, unit,
          dimensions: { lengthIn: Number(m[1]), widthIn: Number(m[2]), heightIn: Number(m[3]) },
          oneHandFold: oneHand ?? null,
        })
      }
      const n = Number(value)
      if (!Number.isFinite(n)) return 'value must be a number'
      return leverInput({ ...common, number: n, unit })
    }
    case LeverType.CATEGORY:
      return leverInput({ ...common, text: value })
    case LeverType.COMPATIBILITY_LIST:
      return leverInput({ ...common, list: value.split('|').map((s) => s.trim()).filter(Boolean) })
    case LeverType.BOOLEAN: {
      const b = yesNo(value)
      if (b === undefined || b === 'invalid') return 'value must be yes or no'
      return leverInput({ ...common, bool: b })
    }
  }
}

function leverInput(candidate: unknown): LeverValueInput | string {
  const parsed = leverValueInputSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  return `${issue.path.join('.') || 'value'}: ${issue.message}`
}

export async function importLeverValues(categoryId: string, text: string, userId: string, dryRun: boolean) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
  if (!category) throw new AppError(404, 'Category not found')
  const records = parseCsv(text, VALUE_COLUMNS)
  const levers = await prisma.valueLever.findMany({
    where: { categoryId, status: LeverStatus.APPROVED },
    select: { id: true, name: true, type: true, inputFormat: true, unit: true, allowedValues: true },
  })
  const byName = new Map(levers.map((l) => [normalizeName(l.name), l]))
  const productIds = [...new Set(records.map((r) => r.product_id).filter(Boolean))]
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true } })
  const productCategory = new Map(products.map((p) => [p.id, p.categoryId]))

  const errors: { row: number; error: string }[] = []
  const writes: { productId: string; leverId: string; data: ValueData }[] = []
  const seen = new Set<string>()
  records.forEach((r, i) => {
    const err = (error: string) => errors.push({ row: rowNumber(i), error })
    const productId = r.product_id ?? ''
    if (!productCategory.has(productId)) return err(`unknown product_id "${productId.slice(0, 40)}"`)
    if (productCategory.get(productId) !== categoryId) return err('the product is not in this category')
    const lever = byName.get(normalizeName(r.lever ?? ''))
    if (!lever) return err(`"${(r.lever ?? '').slice(0, 60)}" is not a published lever of this category`)
    const key = `${productId}:${lever.id}`
    if (seen.has(key)) return err('this product and lever appear twice in the file')
    seen.add(key)
    const input = rowToInput(r, lever)
    if (typeof input === 'string') return err(input)
    const data = toValueData(lever, input)
    if (!data.ok) return err(data.error)
    writes.push({ productId, leverId: lever.id, data: data.data })
  })
  if (errors.length > 0) throw new CsvRowsError(errors)
  if (dryRun) return { valid: true, rows: writes.length, imported: 0 }

  const recordedAt = new Date()
  await prisma.$transaction(
    writes.map((w) =>
      prisma.productLeverValue.upsert({
        where: { productId_leverId: { productId: w.productId, leverId: w.leverId } },
        create: { productId: w.productId, leverId: w.leverId, ...w.data, isSample: false, recordedById: userId, recordedAt },
        update: { ...w.data, isSample: false, recordedById: userId, recordedAt },
      })
    )
  )
  return { valid: true, rows: writes.length, imported: writes.length }
}

/** Admin form: set one product's value for one published lever. */
export async function setLeverValue(productId: string, leverId: string, input: LeverValueInput, userId: string) {
  const [product, lever] = await Promise.all([
    prisma.product.findUnique({ where: { id: productId }, select: { categoryId: true } }),
    prisma.valueLever.findUnique({ where: { id: leverId } }),
  ])
  if (!product) throw new AppError(404, 'Product not found')
  if (!lever) throw new AppError(404, 'Lever not found')
  if (lever.status !== LeverStatus.APPROVED) throw new AppError(409, 'Values can only be set for published levers')
  if (product.categoryId !== lever.categoryId) throw new AppError(400, 'The lever is not in the product\'s category')
  const data = toValueData(lever, input)
  if (!data.ok) throw new AppError(400, data.error)
  const recordedAt = new Date()
  return prisma.productLeverValue.upsert({
    where: { productId_leverId: { productId, leverId } },
    create: { productId, leverId, ...data.data, isSample: false, recordedById: userId, recordedAt },
    update: { ...data.data, isSample: false, recordedById: userId, recordedAt },
  })
}
