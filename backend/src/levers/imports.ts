// CSV imports (docs/adr-levers.md D5, D7): survey rankings and product lever values. Both are all or
// nothing: every row is validated first, any error returns the row numbers, and nothing is written.
import { parse } from 'csv-parse/sync'
import { LeverInputFormat, LeverStatus, LeverType, ValueSourceType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { lockCategory } from './levers'
import { AppError } from '../middleware/errorHandler'
import { normalizeName } from './candidates'
import { LeverValueInput, leverValueInputSchema, toValueData, ValueData } from './values'

export const MAX_CSV_ROWS = 2000

export class CsvRowsError extends AppError {
  constructor(public rows: { row: number; error: string }[]) {
    super(400, `The file has ${rows.length} invalid row${rows.length === 1 ? '' : 's'}; nothing was imported`, { rows })
  }
}

/**
 * Parse CSV text with a header row into records keyed by lower-cased header, each with the line it
 * starts on (as a spreadsheet numbers rows: the header is line 1; blank lines and quoted line breaks count).
 */
export function parseCsv(text: string, required: readonly string[]): { row: Record<string, string>; line: number }[] {
  let records: { row: Record<string, string>; line: number }[]
  try {
    const parsed: { record: Record<string, string>; info: { lines: number; raw?: string } }[] = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      info: true,
      raw: true,
    })
    // info.lines is the line where the record ends; subtract the line breaks inside it (the raw text
    // also carries the blank lines before it and its own line end, which are not part of the record).
    const innerBreaks = (raw: string) => raw.replace(/^(\r?\n)+/, '').replace(/\r?\n$/, '').match(/\n/g)?.length ?? 0
    records = parsed.map((p) => ({ row: p.record, line: p.info.lines - innerBreaks(p.info.raw ?? '') }))
  } catch (err) {
    throw new AppError(400, `Not a valid CSV file: ${err instanceof Error ? err.message.slice(0, 200) : 'parse error'}`)
  }
  if (records.length === 0) throw new AppError(400, 'The file has no data rows')
  if (records.length > MAX_CSV_ROWS) throw new AppError(400, `At most ${MAX_CSV_ROWS} rows per file`)
  const missing = required.filter((c) => !(c in records[0].row))
  if (missing.length > 0) throw new AppError(400, `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
  return records
}

// ── Survey ───────────────────────────────────────────────────────────────────────────────────────────
export const SURVEY_COLUMNS = ['lever', 'rank', 'respondents'] as const

export async function importSurvey(categoryId: string, filename: string, text: string, userId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } })
  if (!category) throw new AppError(404, 'Category not found')
  const records = parseCsv(text, SURVEY_COLUMNS)
  const errors: { row: number; error: string }[] = []
  const rows: { leverName: string; rank: number; respondentCount: number }[] = []
  const seen = new Set<string>()
  records.forEach(({ row: r, line }) => {
    const name = r.lever ?? ''
    const rank = Number(r.rank)
    const respondents = Number(r.respondents)
    if (name.length < 1 || name.length > 60) errors.push({ row: line, error: 'lever must be 1 to 60 characters' })
    else if (seen.has(normalizeName(name))) errors.push({ row: line, error: `duplicate lever "${name}"` })
    else if (!Number.isInteger(rank) || rank < 1) errors.push({ row: line, error: 'rank must be a whole number from 1' })
    else if (!Number.isInteger(respondents) || respondents < 0) errors.push({ row: line, error: 'respondents must be a whole number from 0' })
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
  const records = parseCsv(text, VALUE_COLUMNS)
  // Validate and write under the category lock, so a concurrent publish or lever edit cannot change
  // which levers are published, or their shape, between the checks and the writes.
  return prisma.$transaction(async (tx) => {
    await lockCategory(tx, categoryId)
    const levers = await tx.valueLever.findMany({
      where: { categoryId, status: LeverStatus.APPROVED },
      select: { id: true, name: true, type: true, inputFormat: true, unit: true, allowedValues: true },
    })
    const byName = new Map(levers.map((l) => [normalizeName(l.name), l]))
    const productIds = [...new Set(records.map((r) => r.row.product_id).filter(Boolean))]
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true } })
    const productCategory = new Map(products.map((p) => [p.id, p.categoryId]))

    const errors: { row: number; error: string }[] = []
    const writes: { productId: string; leverId: string; data: ValueData }[] = []
    const seen = new Set<string>()
    for (const { row: r, line } of records) {
      const err = (error: string) => { errors.push({ row: line, error }) }
      const productId = r.product_id ?? ''
      if (!productCategory.has(productId)) { err(`unknown product_id "${productId.slice(0, 40)}"`); continue }
      if (productCategory.get(productId) !== categoryId) { err('the product is not in this category'); continue }
      const lever = byName.get(normalizeName(r.lever ?? ''))
      if (!lever) { err(`"${(r.lever ?? '').slice(0, 60)}" is not a published lever of this category`); continue }
      const key = `${productId}:${lever.id}`
      if (seen.has(key)) { err('this product and lever appear twice in the file'); continue }
      seen.add(key)
      const input = rowToInput(r, lever)
      if (typeof input === 'string') { err(input); continue }
      const data = toValueData(lever, input)
      if (!data.ok) { err(data.error); continue }
      writes.push({ productId, leverId: lever.id, data: data.data })
    }
    if (errors.length > 0) throw new CsvRowsError(errors)
    if (dryRun) return { valid: true, rows: writes.length, imported: 0 }

    const recordedAt = new Date()
    for (const w of writes) {
      await tx.productLeverValue.upsert({
        where: { productId_leverId: { productId: w.productId, leverId: w.leverId } },
        create: { productId: w.productId, leverId: w.leverId, ...w.data, isSample: false, recordedById: userId, recordedAt },
        update: { ...w.data, isSample: false, recordedById: userId, recordedAt },
      })
    }
    return { valid: true, rows: writes.length, imported: writes.length }
  }, { timeout: 60_000 })
}

/** Admin form: set one product's value for one published lever. */
export async function setLeverValue(productId: string, leverId: string, input: LeverValueInput, userId: string) {
  return prisma.$transaction(async (tx) => {
    const ref = await tx.valueLever.findUnique({ where: { id: leverId }, select: { categoryId: true } })
    if (!ref) throw new AppError(404, 'Lever not found')
    // Same lock as publish and lever edits; the lever is read again inside it.
    await lockCategory(tx, ref.categoryId)
    const [product, lever] = await Promise.all([
      tx.product.findUnique({ where: { id: productId }, select: { categoryId: true } }),
      tx.valueLever.findUnique({ where: { id: leverId } }),
    ])
    if (!product) throw new AppError(404, 'Product not found')
    if (!lever) throw new AppError(404, 'Lever not found')
    if (lever.status !== LeverStatus.APPROVED) throw new AppError(409, 'Values can only be set for published levers')
    if (product.categoryId !== lever.categoryId) throw new AppError(400, 'The lever is not in the product\'s category')
    const data = toValueData(lever, input)
    if (!data.ok) throw new AppError(400, data.error)
    const recordedAt = new Date()
    return tx.productLeverValue.upsert({
      where: { productId_leverId: { productId, leverId } },
      create: { productId, leverId, ...data.data, isSample: false, recordedById: userId, recordedAt },
      update: { ...data.data, isSample: false, recordedById: userId, recordedAt },
    })
  })
}
