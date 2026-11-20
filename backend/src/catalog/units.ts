// Canonical units and the fixed conversion table (docs/adr-generation-run.md D7 rule 4). A measurement
// lever stores its value in its definition's canonical unit; the page's own number and unit are kept as
// statedValue / statedUnit. A unit not in this table makes the value unknown (`unit_unknown`).

export const CANONICAL_UNITS = ['lb', 'in', 'cu ft', 'years', 'count'] as const
export type CanonicalUnit = (typeof CANONICAL_UNITS)[number]

export function isCanonicalUnit(u: string | null | undefined): u is CanonicalUnit {
  return typeof u === 'string' && (CANONICAL_UNITS as readonly string[]).includes(u)
}

/** Stated unit spellings (lower case, dots removed) → canonical unit and factor. */
const UNITS: Record<string, { to: CanonicalUnit; factor: number }> = {
  // mass → lb
  lb: { to: 'lb', factor: 1 }, lbs: { to: 'lb', factor: 1 }, pound: { to: 'lb', factor: 1 }, pounds: { to: 'lb', factor: 1 },
  kg: { to: 'lb', factor: 2.20462262 }, kgs: { to: 'lb', factor: 2.20462262 }, kilogram: { to: 'lb', factor: 2.20462262 },
  kilograms: { to: 'lb', factor: 2.20462262 }, g: { to: 'lb', factor: 0.00220462262 }, grams: { to: 'lb', factor: 0.00220462262 },
  oz: { to: 'lb', factor: 0.0625 }, ounce: { to: 'lb', factor: 0.0625 }, ounces: { to: 'lb', factor: 0.0625 },
  // length → in
  in: { to: 'in', factor: 1 }, inch: { to: 'in', factor: 1 }, inches: { to: 'in', factor: 1 }, '"': { to: 'in', factor: 1 },
  cm: { to: 'in', factor: 0.393700787 }, centimeters: { to: 'in', factor: 0.393700787 }, centimetres: { to: 'in', factor: 0.393700787 },
  mm: { to: 'in', factor: 0.0393700787 }, millimeters: { to: 'in', factor: 0.0393700787 }, millimetres: { to: 'in', factor: 0.0393700787 },
  m: { to: 'in', factor: 39.3700787 }, meters: { to: 'in', factor: 39.3700787 }, metres: { to: 'in', factor: 39.3700787 },
  ft: { to: 'in', factor: 12 }, foot: { to: 'in', factor: 12 }, feet: { to: 'in', factor: 12 },
  // volume → cu ft
  'cu ft': { to: 'cu ft', factor: 1 }, 'cubic feet': { to: 'cu ft', factor: 1 }, ft3: { to: 'cu ft', factor: 1 }, 'ft³': { to: 'cu ft', factor: 1 },
  l: { to: 'cu ft', factor: 0.0353146667 }, liter: { to: 'cu ft', factor: 0.0353146667 }, liters: { to: 'cu ft', factor: 0.0353146667 },
  litre: { to: 'cu ft', factor: 0.0353146667 }, litres: { to: 'cu ft', factor: 0.0353146667 },
  'cu in': { to: 'cu ft', factor: 1 / 1728 }, in3: { to: 'cu ft', factor: 1 / 1728 }, 'in³': { to: 'cu ft', factor: 1 / 1728 },
  // time → years
  years: { to: 'years', factor: 1 }, year: { to: 'years', factor: 1 }, yr: { to: 'years', factor: 1 }, yrs: { to: 'years', factor: 1 },
  months: { to: 'years', factor: 1 / 12 }, month: { to: 'years', factor: 1 / 12 }, mo: { to: 'years', factor: 1 / 12 },
  // count (positions, settings, …): no conversion
  count: { to: 'count', factor: 1 }, positions: { to: 'count', factor: 1 }, position: { to: 'count', factor: 1 },
  settings: { to: 'count', factor: 1 }, setting: { to: 'count', factor: 1 }, levels: { to: 'count', factor: 1 },
  level: { to: 'count', factor: 1 }, '': { to: 'count', factor: 1 },
}

export function unitKey(stated: string | null | undefined): string {
  return (stated ?? '').normalize('NFKC').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()
    .replace(/^cubic ft$/, 'cu ft').replace(/^cu\.? ?ft$/, 'cu ft').replace(/^cu\.? ?in$/, 'cu in')
}

/** Spellings of a canonical unit's own family, for the "does the quote state the unit" check. */
export function spellingsFor(stated: string | null | undefined): string[] {
  const key = unitKey(stated)
  const target = UNITS[key]
  if (!target) return []
  return Object.keys(UNITS).filter((k) => k !== '' && UNITS[k].to === target.to && UNITS[k].factor === target.factor)
}

export type Conversion = { value: number; converted: boolean } | null

/** Convert a stated number to the canonical unit, rounded to 2 decimals; null if the unit is unknown or another family. */
export function toCanonical(value: number, stated: string | null | undefined, canonical: string): Conversion {
  if (!Number.isFinite(value)) return null
  const u = UNITS[unitKey(stated)]
  if (!u || u.to !== canonical) return null
  return { value: Math.round(value * u.factor * 100) / 100, converted: u.factor !== 1 }
}
