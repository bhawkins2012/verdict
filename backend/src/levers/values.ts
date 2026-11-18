// Product lever values (docs/adr-levers.md D5). Every path that writes a value (admin form, CSV import,
// seed) goes through toValueData, so the shape rules and the source requirement hold everywhere.
import { z } from 'zod'
import { LeverInputFormat, LeverType, Prisma, ValueSourceType } from '@prisma/client'

export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url('must be a URL')
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')

/** Required on every value: a URL, or an explicit "entered by admin". There is no default. */
export const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(ValueSourceType.URL), url: httpUrl }).strict(),
  z.object({ type: z.literal(ValueSourceType.ADMIN_ENTERED) }).strict(),
])

const dimension = z.number().positive().max(200)

export const leverValueInputSchema = z
  .object({
    unknown: z.boolean().optional(),
    number: z.number().finite().min(0).max(100000).optional(),
    unit: z.string().trim().max(20).optional(),
    text: z.string().trim().min(1).max(100).optional(),
    bool: z.boolean().optional(),
    list: z.array(z.string().trim().min(1).max(120)).min(1).max(100).optional(),
    dimensions: z.object({ lengthIn: dimension, widthIn: dimension, heightIn: dimension }).strict().optional(),
    oneHandFold: z.boolean().nullable().optional(),
    detail: z.string().trim().max(300).optional(),
    source: sourceSchema,
    sourceLabel: z.string().trim().max(100).optional(),
  })
  .strict()

export type LeverValueInput = z.infer<typeof leverValueInputSchema>

export interface LeverForValue {
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  allowedValues: string[]
}

export type ValueData = Omit<Prisma.ProductLeverValueUncheckedCreateInput, 'id' | 'productId' | 'leverId' | 'recordedById' | 'recordedAt' | 'isSample'>

const CUBIC_INCHES_PER_CUBIC_FOOT = 1728

/** Folded volume in cubic feet from inches, rounded to 2 decimals. The only way a DIMENSIONS volume is set. */
export function foldedVolumeCuFt(lengthIn: number, widthIn: number, heightIn: number): number {
  return Math.round((lengthIn * widthIn * heightIn * 100) / CUBIC_INCHES_PER_CUBIC_FOOT) / 100
}

const TYPE_FIELDS: Record<string, readonly (keyof LeverValueInput)[]> = {
  [`${LeverType.MEASUREMENT}:${LeverInputFormat.SINGLE}`]: ['number', 'unit'],
  [`${LeverType.MEASUREMENT}:${LeverInputFormat.DIMENSIONS}`]: ['dimensions', 'oneHandFold', 'unit'],
  [`${LeverType.CATEGORY}:${LeverInputFormat.SINGLE}`]: ['text'],
  [`${LeverType.COMPATIBILITY_LIST}:${LeverInputFormat.SINGLE}`]: ['list'],
  [`${LeverType.BOOLEAN}:${LeverInputFormat.SINGLE}`]: ['bool'],
}
const VALUE_FIELDS: readonly (keyof LeverValueInput)[] = ['number', 'unit', 'text', 'bool', 'list', 'dimensions', 'oneHandFold']

type Result = { ok: true; data: ValueData } | { ok: false; error: string }

/** Check a value against its lever and turn it into database fields. */
export function toValueData(lever: LeverForValue, input: LeverValueInput): Result {
  const allowed = TYPE_FIELDS[`${lever.type}:${lever.inputFormat}`]
  if (!allowed) return { ok: false, error: 'this lever has an invalid input format' }
  const given = VALUE_FIELDS.filter((f) => input[f] !== undefined)
  const source = input.source.type === ValueSourceType.URL
    ? { sourceType: ValueSourceType.URL, sourceUrl: input.source.url }
    : { sourceType: ValueSourceType.ADMIN_ENTERED, sourceUrl: null }
  const base = {
    ...source,
    sourceLabel: input.sourceLabel || null,
    detail: input.detail || null,
    isUnknown: false,
    valueNumber: null,
    unit: null,
    valueText: null,
    valueBool: null,
    valueList: [],
    dimLengthIn: null,
    dimWidthIn: null,
    dimHeightIn: null,
  }

  if (input.unknown) {
    if (given.length > 0) return { ok: false, error: 'an unknown value cannot also have a value' }
    return { ok: true, data: { ...base, isUnknown: true } }
  }
  const stray = given.filter((f) => !allowed.includes(f))
  if (stray.length > 0) return { ok: false, error: `${stray.join(', ')} does not apply to this lever` }

  switch (lever.type) {
    case LeverType.MEASUREMENT: {
      if (lever.inputFormat === LeverInputFormat.DIMENSIONS) {
        if (!input.dimensions) return { ok: false, error: 'folded length, width and height (inches) are required' }
        if (input.unit !== undefined && input.unit !== 'in') return { ok: false, error: 'dimensions are in inches' }
        const { lengthIn, widthIn, heightIn } = input.dimensions
        return {
          ok: true,
          data: {
            ...base, dimLengthIn: lengthIn, dimWidthIn: widthIn, dimHeightIn: heightIn,
            valueNumber: foldedVolumeCuFt(lengthIn, widthIn, heightIn), unit: lever.unit,
            valueBool: input.oneHandFold ?? null,
          },
        }
      }
      if (input.number === undefined) return { ok: false, error: 'a number is required' }
      if (input.unit !== undefined && input.unit !== lever.unit) return { ok: false, error: `the unit must be ${lever.unit}` }
      return { ok: true, data: { ...base, valueNumber: input.number, unit: lever.unit } }
    }
    case LeverType.CATEGORY: {
      if (input.text === undefined) return { ok: false, error: 'a value is required' }
      const match = lever.allowedValues.find((v) => v.toLowerCase() === input.text?.toLowerCase())
      if (!match) return { ok: false, error: `the value must be one of: ${lever.allowedValues.join(', ')}` }
      return { ok: true, data: { ...base, valueText: match } }
    }
    case LeverType.COMPATIBILITY_LIST: {
      if (!input.list) return { ok: false, error: 'at least one compatible item is required' }
      const seen = new Set<string>()
      const list = input.list.filter((v) => (seen.has(v.toLowerCase()) ? false : (seen.add(v.toLowerCase()), true)))
      return { ok: true, data: { ...base, valueList: list } }
    }
    case LeverType.BOOLEAN: {
      if (input.bool === undefined) return { ok: false, error: 'yes or no is required' }
      return { ok: true, data: { ...base, valueBool: input.bool } }
    }
  }
}

/** The public shape of a stored value (product page, admin views). */
export function presentValue(v: {
  isUnknown: boolean; valueNumber: number | null; unit: string | null; valueText: string | null; valueBool: boolean | null
  valueList: string[]; dimLengthIn: number | null; dimWidthIn: number | null; dimHeightIn: number | null; detail: string | null
  sourceType: ValueSourceType; sourceUrl: string | null; sourceLabel: string | null; isSample: boolean; recordedAt: Date
}) {
  return {
    unknown: v.isUnknown,
    number: v.valueNumber,
    unit: v.unit,
    text: v.valueText,
    bool: v.valueBool,
    list: v.valueList,
    dimensions: v.dimLengthIn !== null && v.dimWidthIn !== null && v.dimHeightIn !== null
      ? { lengthIn: v.dimLengthIn, widthIn: v.dimWidthIn, heightIn: v.dimHeightIn }
      : null,
    detail: v.detail,
    source: { type: v.sourceType, url: v.sourceUrl, label: v.sourceLabel },
    isSample: v.isSample,
    recordedAt: v.recordedAt,
  }
}
