// Evidence rules, applied in code to every extracted value (docs/adr-generation-run.md D7). The model's
// answer is a claim; a value is stored only when its quote is verbatim in the fetched text and the value
// itself is in the quote. The first failed rule makes the value unknown, with the reason. Nothing is ever
// filled in from elsewhere, and the model's confidence can only be lowered here, never raised.
import { Confidence, LeverInputFormat, LeverType } from '@prisma/client'
import { containsWords, normalizeEvidence, quoteAppearsIn } from '../catalog/text'
import { spellingsFor, toCanonical } from '../catalog/units'
import { EMPTY_VALUE, foldedVolumeCuFt, ValueColumns } from '../catalog/values'
import { ExtractedValue } from './schemas'

export const MAX_QUOTE_CHARS = 300

export interface EvidenceDocument { key: string; url: string; text: string }

export interface DefinitionForEvidence {
  type: LeverType
  inputFormat: LeverInputFormat
  unit: string | null
  allowedValues: string[]
  minValue: number | null
  maxValue: number | null
}

export type EvidenceResult =
  | { ok: true; columns: ValueColumns; quote: string; sourceUrl: string; statedValue: string | null; statedUnit: string | null; confidence: Confidence }
  | { ok: false; reason: string; columns: ValueColumns; quote: string | null; sourceUrl: string | null; statedValue: string | null; statedUnit: string | null }

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }
const lower = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A number as written ("9.1", "20", "1,200") parsed, or null. */
export function parseStatedNumber(s: string | null): number | null {
  if (s === null) return null
  const t = s.trim()
  if (!/^\d{1,6}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(t)) return null
  const n = Number(t.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Is this number (as written) a whole number token in the quote? "9.1" is not found in "19.1" or "9.15". */
export function numberInQuote(stated: string, quote: string): boolean {
  const re = new RegExp(`(?<![\\d.,])${escapeRe(stated.trim())}(?![\\d]|[.,]\\d)`)
  return re.test(normalizeEvidence(quote))
}

/** Does the quote state this unit (any spelling of it), right after a number or as a word? */
function unitInQuote(statedUnit: string | null, quote: string): boolean {
  const spellings = spellingsFor(statedUnit)
  if (spellings.length === 0) return false
  const q = normalizeEvidence(quote).toLowerCase()
  return spellings.some((s) => {
    const sp = escapeRe(s.toLowerCase())
    // Short spellings ("in", "g", "m", "l") only count right after a number; longer ones anywhere as a word.
    const afterNumber = new RegExp(`\\d\\s?${sp}(?![a-z])`)
    const asWord = new RegExp(`(^|[^a-z])${sp}([^a-z]|$)`)
    return afterNumber.test(q) || (s.length > 2 && asWord.test(q))
  })
}

/**
 * Does the quote state this number with this unit right after it ("4.3 kg", "4.3kg", "32 in", "21\")?
 * Ties the unit to the number, so "9.1 kg; up to 22 lb" never reads as 22 kg.
 */
export function numberWithUnit(stated: string, statedUnit: string | null, quote: string): boolean {
  const spellings = spellingsFor(statedUnit).filter((s) => s.length > 0).sort((a, b) => b.length - a.length)
  if (spellings.length === 0) return false
  const q = normalizeEvidence(quote).toLowerCase()
  const units = spellings.map((s) => escapeRe(s.toLowerCase())).join('|')
  return new RegExp(`(?<![\\d.,])${escapeRe(stated.trim())}\\s?(?:${units})(?![a-z])`).test(q)
}

const NEGATION = /\b(no|not|none|without|n\/a|non)\b|\bnon-/i

export function checkEvidence(def: DefinitionForEvidence, raw: ExtractedValue, docs: readonly EvidenceDocument[]): EvidenceResult {
  const quote = raw.quote?.trim() || null
  const doc = docs.find((d) => d.key === raw.source) ?? null
  const fail = (reason: string): EvidenceResult => ({
    ok: false, reason, columns: { ...EMPTY_VALUE }, quote, sourceUrl: doc?.url ?? null, statedValue: raw.statedValue, statedUnit: raw.statedUnit,
  })

  // Rule 1: not stated.
  if (!raw.found) return fail('not_stated')
  // Rule 2: the quote is verbatim in the document it names.
  if (!quote) return fail('quote_missing')
  if (quote.length > MAX_QUOTE_CHARS) return fail('quote_too_long')
  if (!doc) return fail('quote_not_found')
  if (!quoteAppearsIn(doc.text, quote)) return fail('quote_not_found')

  let confidence: Confidence = raw.confidence
  const base: ValueColumns = { ...EMPTY_VALUE, isUnknown: false }
  const ok = (columns: ValueColumns): EvidenceResult => ({
    ok: true, columns, quote, sourceUrl: doc.url, statedValue: raw.statedValue, statedUnit: raw.statedUnit, confidence,
  })

  // Rule 3 (value in the quote), rule 4 (units), rule 5 (shape), rule 6 (plausibility).
  switch (def.type) {
    case LeverType.MEASUREMENT: {
      if (!def.unit) return fail('definition_without_unit')
      if (def.inputFormat === LeverInputFormat.DIMENSIONS) {
        const d = raw.dimensions
        if (!d) return fail('dimensions_missing')
        const parts = [d.length, d.width, d.height]
        const nums = parts.map(parseStatedNumber)
        if (nums.some((n) => n === null || n <= 0)) return fail('number_unreadable')
        if (parts.some((p) => !numberInQuote(p, quote))) return fail('number_not_in_quote')
        const inches = nums.map((n) => toCanonical(n ?? NaN, raw.statedUnit, 'in'))
        if (inches.some((c) => c === null)) return fail('unit_unknown')
        if (!parts.some((p) => numberWithUnit(p, raw.statedUnit, quote))) return fail('unit_not_in_quote')
        const [l, w, h] = inches.map((c) => c?.value ?? 0)
        if (inches.some((c) => c?.converted)) confidence = lower(confidence, Confidence.MEDIUM)
        const oneHand = raw.oneHandFold === true && /one[- ]hand/i.test(quote) ? true : null
        return ok({ ...base, dimLengthIn: l, dimWidthIn: w, dimHeightIn: h, valueNumber: foldedVolumeCuFt(l, w, h), unit: def.unit, valueBool: oneHand })
      }
      const stated = raw.statedValue?.trim() ?? null
      const n = parseStatedNumber(stated)
      if (stated === null || n === null) return fail('number_unreadable')
      if (!numberInQuote(stated, quote)) return fail('number_not_in_quote')
      const conv = toCanonical(n, raw.statedUnit, def.unit)
      if (!conv) return fail('unit_unknown')
      if (def.unit !== 'count' && !numberWithUnit(stated, raw.statedUnit, quote)) return fail('unit_not_in_quote')
      if (conv.converted && !unitInQuote(def.unit, quote)) confidence = lower(confidence, Confidence.MEDIUM)
      if ((def.minValue !== null && conv.value < def.minValue) || (def.maxValue !== null && conv.value > def.maxValue)) {
        confidence = Confidence.LOW
      }
      return ok({ ...base, valueNumber: conv.value, unit: def.unit })
    }
    case LeverType.CATEGORY: {
      const match = def.allowedValues.find((v) => v.toLowerCase() === raw.choice?.trim().toLowerCase())
      if (!match) return fail('not_an_allowed_value')
      // The mapping from the page's words to an allowed value cannot be proven in code.
      confidence = lower(confidence, Confidence.MEDIUM)
      return ok({ ...base, valueText: match })
    }
    case LeverType.COMPATIBILITY_LIST: {
      const items = (raw.items ?? []).map((i) => i.trim()).filter(Boolean)
      if (items.length === 0) return fail('items_missing')
      if (items.some((i) => !containsWords(quote, i))) return fail('item_not_in_quote')
      const seen = new Set<string>()
      return ok({ ...base, valueList: items.filter((i) => (seen.has(i.toLowerCase()) ? false : (seen.add(i.toLowerCase()), true))) })
    }
    case LeverType.BOOLEAN: {
      if (raw.bool === null) return fail('answer_missing')
      // "No" needs an explicit statement; a feature that is simply not mentioned is unknown, never "no".
      if (raw.bool === false && !NEGATION.test(quote)) return fail('no_not_explicit')
      return ok({ ...base, valueBool: raw.bool })
    }
  }
}
