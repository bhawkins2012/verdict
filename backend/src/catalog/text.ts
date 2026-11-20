// Normalization shared by the catalog and the generation run. Every comparison of names, brands, hosts
// and evidence goes through these, so the rules are the same everywhere.

/** Case- and whitespace-insensitive name key (levers, survey rows, product names). */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** A brand as a key: lower-case letters and digits only ("Maxi-Cosi" → "maxicosi", "UPPAbaby" → "uppababy"). */
export function brandKey(brand: string): string {
  return brand.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Words for a loose match of a model or site name: lower case, letters and digits, single spaces. */
export function wordsKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** True if `needle`'s words appear as a run of whole words in `haystack` (both via wordsKey). */
export function containsWords(haystack: string, needle: string): boolean {
  const n = wordsKey(needle)
  if (!n) return false
  return ` ${wordsKey(haystack)} `.includes(` ${n} `)
}

/**
 * Evidence text normalization (docs/adr-generation-run.md D7): NFKC, typographic quotes and dashes as their
 * ASCII forms (pages and the model differ on these), every run of whitespace (including no-break spaces)
 * as one space. Case and all other punctuation are kept, so a match is still verbatim.
 */
export function normalizeEvidence(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Is `quote` verbatim in `text` (after normalizeEvidence on both)? */
export function quoteAppearsIn(text: string, quote: string): boolean {
  const q = normalizeEvidence(quote)
  return q.length > 0 && normalizeEvidence(text).includes(q)
}

export function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
