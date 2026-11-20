// The shape of a lever value (docs/adr-generation-run.md D2, D7 rule 5). Every write of a typed value
// (extraction, an admin edit, a manual value) goes through toValueData, so the type rules hold everywhere.
import { z } from 'zod'
import { LeverInputFormat, LeverType } from '@prisma/client'

const dimension = z.number().positive().max(200)

export const valueInputSchema = z
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
  })
  .strict()

export type ValueInput = z.infer<typeof valueInputSchema>

export interface DefinitionShape {
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  allowedValues: string[]
}

export interface ValueColumns {
  isUnknown: boolean
  valueNumber: number | null
  unit: string | null
  valueText: string | null
  valueBool: boolean | null
  valueList: string[]
  dimLengthIn: number | null
  dimWidthIn: number | null
  dimHeightIn: number | null
  detail: string | null
}

export const EMPTY_VALUE: ValueColumns = {
  isUnknown: true, valueNumber: null, unit: null, valueText: null, valueBool: null, valueList: [],
  dimLengthIn: null, dimWidthIn: null, dimHeightIn: null, detail: null,
}

const CUBIC_INCHES_PER_CUBIC_FOOT = 1728

/** Folded volume in cubic feet from inches, rounded to 2 decimals. The only way a DIMENSIONS volume is set. */
export function foldedVolumeCuFt(lengthIn: number, widthIn: number, heightIn: number): number {
  return Math.round((lengthIn * widthIn * heightIn * 100) / CUBIC_INCHES_PER_CUBIC_FOOT) / 100
}

const TYPE_FIELDS: Record<string, readonly (keyof ValueInput)[]> = {
  [`${LeverType.MEASUREMENT}:${LeverInputFormat.SINGLE}`]: ['number', 'unit'],
  [`${LeverType.MEASUREMENT}:${LeverInputFormat.DIMENSIONS}`]: ['dimensions', 'oneHandFold', 'unit'],
  [`${LeverType.CATEGORY}:${LeverInputFormat.SINGLE}`]: ['text'],
  [`${LeverType.COMPATIBILITY_LIST}:${LeverInputFormat.SINGLE}`]: ['list'],
  [`${LeverType.BOOLEAN}:${LeverInputFormat.SINGLE}`]: ['bool'],
}
const VALUE_FIELDS: readonly (keyof ValueInput)[] = ['number', 'unit', 'text', 'bool', 'list', 'dimensions', 'oneHandFold']

export type ShapeResult = { ok: true; data: ValueColumns } | { ok: false; error: string }

/** Check a value against its definition and turn it into the typed columns. */
export function toValueData(def: DefinitionShape, input: ValueInput): ShapeResult {
  const allowed = TYPE_FIELDS[`${def.type}:${def.inputFormat}`]
  if (!allowed) return { ok: false, error: 'this lever has an invalid input format' }
  const given = VALUE_FIELDS.filter((f) => input[f] !== undefined)
  const base: ValueColumns = { ...EMPTY_VALUE, isUnknown: false, detail: input.detail || null }

  if (input.unknown) {
    if (given.length > 0) return { ok: false, error: 'an unknown value cannot also have a value' }
    return { ok: true, data: { ...EMPTY_VALUE, detail: input.detail || null } }
  }
  const stray = given.filter((f) => !allowed.includes(f))
  if (stray.length > 0) return { ok: false, error: `${stray.join(', ')} does not apply to this lever` }

  switch (def.type) {
    case LeverType.MEASUREMENT: {
      if (def.inputFormat === LeverInputFormat.DIMENSIONS) {
        if (!input.dimensions) return { ok: false, error: 'length, width and height (inches) are required' }
        if (input.unit !== undefined && input.unit !== 'in') return { ok: false, error: 'dimensions are in inches' }
        const { lengthIn, widthIn, heightIn } = input.dimensions
        return {
          ok: true,
          data: {
            ...base, dimLengthIn: lengthIn, dimWidthIn: widthIn, dimHeightIn: heightIn,
            valueNumber: foldedVolumeCuFt(lengthIn, widthIn, heightIn), unit: def.unit, valueBool: input.oneHandFold ?? null,
          },
        }
      }
      if (input.number === undefined) return { ok: false, error: 'a number is required' }
      if (input.unit !== undefined && input.unit !== def.unit) return { ok: false, error: `the unit must be ${def.unit}` }
      return { ok: true, data: { ...base, valueNumber: input.number, unit: def.unit } }
    }
    case LeverType.CATEGORY: {
      if (input.text === undefined) return { ok: false, error: 'a value is required' }
      const match = def.allowedValues.find((v) => v.toLowerCase() === input.text?.toLowerCase())
      if (!match) return { ok: false, error: `the value must be one of: ${def.allowedValues.join(', ')}` }
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

/** The typed value as a plain object (API responses). */
export function presentTyped(v: ValueColumns) {
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
  }
}

export function valueColumnsOf(v: ValueColumns): ValueColumns {
  return {
    isUnknown: v.isUnknown, valueNumber: v.valueNumber, unit: v.unit, valueText: v.valueText, valueBool: v.valueBool,
    valueList: v.valueList, dimLengthIn: v.dimLengthIn, dimWidthIn: v.dimWidthIn, dimHeightIn: v.dimHeightIn, detail: v.detail,
  }
}
