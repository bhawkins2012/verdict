// Evidence rules (docs/adr-generation-run.md D7): verbatim quote, the value in the quote, units, unknown
// never guessed. Pure functions: no database.
import { Confidence, LeverInputFormat, LeverType } from '@prisma/client'
import { checkEvidence, DefinitionForEvidence, numberInQuote } from '../../src/generation/evidence'
import { ExtractedValue } from '../../src/generation/schemas'
import { toCanonical } from '../../src/catalog/units'
import { normalizeEvidence, quoteAppearsIn } from '../../src/catalog/text'

const PAGE = `Acme Glide Infant Car Seat
Specifications
Carrier weight: 4.3 kg
Maximum child weight: 35 lb
Maximum child height: 81 cm
Folded size: 22 x 18 x 9 in, one-hand fold
Load leg: Yes
Anti-rebound bar: No anti-rebound bar
Compatible strollers: Fits Acme City Stroller and Nestwell Roam Stroller
Base installation: Rigid LATCH
Expiration: 7 years from date of manufacture
Capacity: 70 L
Weight limit: 19.1 lb`
const docs = [{ key: 'page', url: 'https://acme.example/glide', text: PAGE }, { key: 'pdf1', url: 'https://acme.example/glide.pdf', text: 'Seat height: 21.5 in' }]

const def = (type: LeverType, unit: string | null, extra: Partial<DefinitionForEvidence> = {}): DefinitionForEvidence => ({
  type, unit, inputFormat: LeverInputFormat.SINGLE, allowedValues: [], minValue: null, maxValue: null, ...extra,
})
const raw = (r: Partial<ExtractedValue>): ExtractedValue => ({
  lever: 'L1', found: true, statedValue: null, statedUnit: null, dimensions: null, items: null, choice: null, bool: null, oneHandFold: null,
  quote: null, source: 'page', confidence: 'HIGH', ...r,
})
const lb = def(LeverType.MEASUREMENT, 'lb')

describe('verbatim quote', () => {
  it('a quote that is on the page passes', () => {
    const r = checkEvidence(lb, raw({ statedValue: '35', statedUnit: 'lb', quote: 'Maximum child weight: 35 lb' }), docs)
    expect(r.ok && r.columns.valueNumber).toBe(35)
  })

  it('a paraphrased quote is unknown (quote_not_found)', () => {
    const r = checkEvidence(def(LeverType.MEASUREMENT, 'years'), raw({ statedValue: '7', statedUnit: 'years', quote: 'Expires seven years after manufacture' }), docs)
    expect(r).toMatchObject({ ok: false, reason: 'quote_not_found' })
  })

  it('spacing, no-break spaces and typographic quotes do not matter; case and other punctuation do', () => {
    expect(quoteAppearsIn('Weight: 4.3  kg', 'Weight: 4.3 kg')).toBe(true)
    expect(quoteAppearsIn('It’s 4.3 kg', "It's 4.3 kg")).toBe(true)
    expect(quoteAppearsIn('Weight: 4.3 kg', 'weight: 4.3 kg')).toBe(false)
    expect(quoteAppearsIn('Weight: 4.3 kg', 'Weight 4.3 kg')).toBe(false)
    expect(normalizeEvidence(' a \n b ')).toBe('a b')
  })

  it('the quote must be in the document it names', () => {
    const r = checkEvidence(def(LeverType.MEASUREMENT, 'in'), raw({ statedValue: '21.5', statedUnit: 'in', quote: 'Seat height: 21.5 in', source: 'page' }), docs)
    expect(r).toMatchObject({ ok: false, reason: 'quote_not_found' })
    const ok = checkEvidence(def(LeverType.MEASUREMENT, 'in'), raw({ statedValue: '21.5', statedUnit: 'in', quote: 'Seat height: 21.5 in', source: 'pdf1' }), docs)
    expect(ok).toMatchObject({ ok: true, sourceUrl: 'https://acme.example/glide.pdf' })
  })

  it('a missing or overlong quote is unknown', () => {
    expect(checkEvidence(lb, raw({ statedValue: '35', statedUnit: 'lb', quote: null }), docs)).toMatchObject({ ok: false, reason: 'quote_missing' })
    expect(checkEvidence(lb, raw({ statedValue: '35', statedUnit: 'lb', quote: 'x'.repeat(301) }), docs)).toMatchObject({ ok: false, reason: 'quote_too_long' })
  })
})

describe('unknown is never guessed', () => {
  it('not stated → unknown, with every value column empty', () => {
    const r = checkEvidence(lb, raw({ found: false }), docs)
    expect(r).toMatchObject({ ok: false, reason: 'not_stated' })
    expect(r.columns.isUnknown).toBe(true)
    expect(r.columns.valueNumber).toBeNull()
  })

  it('the number must be in the quote as a whole number ("9.1" is not in "19.1")', () => {
    expect(numberInQuote('9.1', 'Weight limit: 19.1 lb')).toBe(false)
    expect(numberInQuote('19.1', 'Weight limit: 19.1 lb')).toBe(true)
    expect(numberInQuote('9', 'Width: 9.5 in')).toBe(false)
    expect(numberInQuote('35', 'up to 35 lb.')).toBe(true)
    expect(checkEvidence(lb, raw({ statedValue: '9.1', statedUnit: 'lb', quote: 'Weight limit: 19.1 lb' }), docs)).toMatchObject({ ok: false, reason: 'number_not_in_quote' })
    expect(checkEvidence(lb, raw({ statedValue: '36', statedUnit: 'lb', quote: 'Maximum child weight: 35 lb' }), docs)).toMatchObject({ ok: false, reason: 'number_not_in_quote' })
  })

  it('"no" needs an explicit statement; an unmentioned feature is unknown', () => {
    const bool = def(LeverType.BOOLEAN, null)
    expect(checkEvidence(bool, raw({ bool: false, quote: 'Load leg: Yes' }), docs)).toMatchObject({ ok: false, reason: 'no_not_explicit' })
    const no = checkEvidence(bool, raw({ bool: false, quote: 'Anti-rebound bar: No anti-rebound bar' }), docs)
    expect(no.ok && no.columns.valueBool).toBe(false)
    const yes = checkEvidence(bool, raw({ bool: true, quote: 'Load leg: Yes' }), docs)
    expect(yes.ok && yes.columns.valueBool).toBe(true)
  })

  it('a category must be an allowed value (and is capped at MEDIUM confidence)', () => {
    const cat = def(LeverType.CATEGORY, null, { allowedValues: ['Rigid LATCH', 'Belt only'] })
    expect(checkEvidence(cat, raw({ choice: 'Isofix', quote: 'Base installation: Rigid LATCH' }), docs)).toMatchObject({ ok: false, reason: 'not_an_allowed_value' })
    const r = checkEvidence(cat, raw({ choice: 'rigid latch', quote: 'Base installation: Rigid LATCH' }), docs)
    expect(r).toMatchObject({ ok: true, confidence: Confidence.MEDIUM })
    expect(r.columns.valueText).toBe('Rigid LATCH')
  })

  it('every list item must be in the quote', () => {
    const list = def(LeverType.COMPATIBILITY_LIST, null)
    const q = 'Compatible strollers: Fits Acme City Stroller and Nestwell Roam Stroller'
    expect(checkEvidence(list, raw({ items: ['Acme City Stroller', 'Nestwell Roam Stroller'], quote: q }), docs).ok).toBe(true)
    expect(checkEvidence(list, raw({ items: ['Acme City Stroller', 'Brightway Halo'], quote: q }), docs)).toMatchObject({ ok: false, reason: 'item_not_in_quote' })
  })

  it('the stated unit must be in the quote', () => {
    expect(checkEvidence(lb, raw({ statedValue: '35', statedUnit: 'kg', quote: 'Maximum child weight: 35 lb' }), docs)).toMatchObject({ ok: false, reason: 'unit_not_in_quote' })
  })

  it('the unit must follow the number it measures, not appear elsewhere in the quote', () => {
    const d = [{ key: 'page', url: 'https://acme.example/glide', text: 'Carrier: 9.1 kg; fits babies up to 22 lb' }]
    expect(checkEvidence(lb, raw({ statedValue: '22', statedUnit: 'kg', quote: 'Carrier: 9.1 kg; fits babies up to 22 lb' }), d)).toMatchObject({ ok: false, reason: 'unit_not_in_quote' })
    expect(checkEvidence(lb, raw({ statedValue: '22', statedUnit: 'lb', quote: 'Carrier: 9.1 kg; fits babies up to 22 lb' }), d).ok).toBe(true)
    expect(checkEvidence(lb, raw({ statedValue: '9.1', statedUnit: 'kg', quote: 'Carrier: 9.1 kg; fits babies up to 22 lb' }), d).ok).toBe(true)
  })
})

describe('unit conversion', () => {
  it('kg → lb, cm → in, L → cu ft, months → years, rounded to 2 decimals', () => {
    expect(toCanonical(4.3, 'kg', 'lb')).toEqual({ value: 9.48, converted: true })
    expect(toCanonical(81, 'cm', 'in')).toEqual({ value: 31.89, converted: true })
    expect(toCanonical(70, 'L', 'cu ft')).toEqual({ value: 2.47, converted: true })
    expect(toCanonical(18, 'months', 'years')).toEqual({ value: 1.5, converted: true })
    expect(toCanonical(20, 'lbs', 'lb')).toEqual({ value: 20, converted: false })
    expect(toCanonical(4, 'positions', 'count')).toEqual({ value: 4, converted: false })
  })

  it('an unknown unit, or one from another family, gives no value', () => {
    expect(toCanonical(3, 'stone', 'lb')).toBeNull()
    expect(toCanonical(3, 'kg', 'in')).toBeNull()
    expect(checkEvidence(lb, raw({ statedValue: '4.3', statedUnit: 'stone', quote: 'Carrier weight: 4.3 kg' }), docs)).toMatchObject({ ok: false, reason: 'unit_unknown' })
  })

  it('a converted value keeps the stated value and unit, and its confidence is capped at MEDIUM', () => {
    const r = checkEvidence(lb, raw({ statedValue: '4.3', statedUnit: 'kg', quote: 'Carrier weight: 4.3 kg' }), docs)
    expect(r).toMatchObject({ ok: true, statedValue: '4.3', statedUnit: 'kg', confidence: Confidence.MEDIUM })
    expect(r.columns).toMatchObject({ valueNumber: 9.48, unit: 'lb' })
    const cm = checkEvidence(def(LeverType.MEASUREMENT, 'in'), raw({ statedValue: '81', statedUnit: 'cm', quote: 'Maximum child height: 81 cm' }), docs)
    expect(cm.columns.valueNumber).toBe(31.89)
    const l = checkEvidence(def(LeverType.MEASUREMENT, 'cu ft'), raw({ statedValue: '70', statedUnit: 'L', quote: 'Capacity: 70 L' }), docs)
    expect(l.columns.valueNumber).toBe(2.47)
  })

  it('dimensions: all three numbers in the quote, volume computed, one-hand fold only when stated', () => {
    const dims = def(LeverType.MEASUREMENT, 'cu ft', { inputFormat: LeverInputFormat.DIMENSIONS })
    const q = 'Folded size: 22 x 18 x 9 in, one-hand fold'
    const r = checkEvidence(dims, raw({ dimensions: { length: '22', width: '18', height: '9' }, statedUnit: 'in', oneHandFold: true, quote: q }), docs)
    expect(r.columns).toMatchObject({ dimLengthIn: 22, dimWidthIn: 18, dimHeightIn: 9, valueNumber: 2.06, valueBool: true })
    expect(checkEvidence(dims, raw({ dimensions: { length: '22', width: '18', height: '10' }, statedUnit: 'in', quote: q }), docs)).toMatchObject({ ok: false, reason: 'number_not_in_quote' })
  })

  it('a value outside the definition\'s plausible range is kept with LOW confidence', () => {
    const r = checkEvidence(def(LeverType.MEASUREMENT, 'lb', { minValue: 1, maxValue: 30 }), raw({ statedValue: '35', statedUnit: 'lb', quote: 'Maximum child weight: 35 lb' }), docs)
    expect(r).toMatchObject({ ok: true, confidence: Confidence.LOW })
  })
})
