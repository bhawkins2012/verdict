// Hosts and the retailer/review-site denylist (docs/adr-generation-run.md D6.2, D6.3, section 5 A1).
import { getDomainWithoutSuffix } from 'tldts'

/** A host as stored: lower case, no trailing dot, no leading "www." ("www.x.com" and "x.com" are one host). */
export function hostKey(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

/**
 * hostKey of a URL's host, or null for anything that is not a public https URL: no credentials, the default
 * port only, no IP literals, no localhost, no single-label or internal names.
 */
export function httpsHostKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.port !== '') return null
    const h = u.hostname.toLowerCase().replace(/\.$/, '')
    if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith('[') || h.includes(':')) return null
    if (!h.includes('.') || h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return null
    return hostKey(h)
  } catch {
    return null
  }
}

/** The registrable-domain label (left of the public suffix), hyphens removed: "maxi-cosi.co.uk" → "maxicosi". */
export function registrableLabel(host: string): string | null {
  // Private suffixes (myshopify.com, …) count as public here, so a shop subdomain never passes the brand check.
  const label = getDomainWithoutSuffix(host, { allowPrivateDomains: false })
  return label ? label.toLowerCase().replace(/[^a-z0-9]/g, '') : null
}

/**
 * Retailers, marketplaces, review sites and social networks: never on the allow-list, never fetched, even
 * with an admin's confirmation (spec: "Retailers and review sites are excluded"). Matched on the
 * registrable-domain label, so every country domain is covered (amazon.com, amazon.co.uk, …).
 */
export const DENYLISTED_LABELS: ReadonlySet<string> = new Set([
  'amazon', 'walmart', 'target', 'babylist', 'buybuybaby', 'babiesrus', 'toysrus', 'yelp', 'ebay', 'bestbuy',
  'reddit', 'consumerreports', 'google', 'youtube', 'facebook', 'instagram', 'pinterest', 'tiktok', 'twitter',
  'x', 'wikipedia', 'babygearlab', 'thebump', 'whattoexpect', 'nytimes', 'etsy', 'aliexpress', 'temu', 'kohls',
  'macys', 'nordstrom', 'costco', 'samsclub', 'bjs', 'potterybarnkids', 'crateandbarrel', 'wayfair', 'kidsembrace',
  'trustpilot', 'goodhousekeeping', 'parents', 'babycenter', 'healthline', 'verywellfamily', 'albeebaby',
  'pishposhbaby', 'nordstromrack', 'mindfulparenting', 'rei', 'dickssportinggoods', 'jcpenney', 'shopify',
])

export function isDenylisted(host: string): boolean {
  const label = getDomainWithoutSuffix(host, { allowPrivateDomains: false })
  return label !== null && DENYLISTED_LABELS.has(label.toLowerCase())
}

/** Same host, treating www. and the bare host as one. */
export function sameHost(a: string, b: string): boolean {
  return hostKey(a) === hostKey(b)
}
