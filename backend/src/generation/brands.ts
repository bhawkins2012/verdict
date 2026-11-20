// Brand domains: the allow-list (docs/adr-generation-run.md section 5 A1). A host is verified for a brand
// automatically when it is https, not denylisted, its registrable-domain label contains the brand, and its
// home page names the brand (schema.org Organization/Brand or og:site_name). Otherwise an admin confirms it
// once, ever. Fetching the home page is the only request made to a host before it is verified.
import { BrandDomainStatus, BrandVerifiedVia, FetchOutcome, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { brandKey, wordsKey } from '../catalog/text'
import { Fetcher } from './fetch/fetcher'
import { hostKey, httpsHostKey, isDenylisted, registrableLabel } from './fetch/hosts'
import { parseHtml } from './fetch/html'

/** Words a site name may add after the brand ("Graco Baby", "Evenflo USA") and still match it. */
const GENERIC_WORDS = new Set(['the', 'baby', 'babies', 'kids', 'usa', 'us', 'uk', 'official', 'site', 'inc', 'llc', 'ltd', 'co', 'company', 'corp', 'gmbh', 'store', 'shop', 'online', 'global', 'brand', 'website', 'home'])

/** Does a site name match the brand? Equal after normalization, ignoring generic words at either end. */
export function siteNameMatches(siteName: string, brand: string): boolean {
  const words = wordsKey(siteName).split(' ').filter(Boolean)
  while (words.length > 1 && GENERIC_WORDS.has(words[words.length - 1])) words.pop()
  while (words.length > 1 && GENERIC_WORDS.has(words[0])) words.shift()
  const key = words.join('')
  return key.length > 0 && key === brandKey(brand)
}

export interface BrandCheck {
  https: boolean
  denylisted: boolean
  labelContainsBrand: boolean
  homepage: FetchOutcome | 'not_fetched'
  siteNames: string[]
  siteNameMatches: boolean
  failed: string | null
}

export type VerifyOutcome =
  | { status: 'verified'; host: string }
  | { status: 'pending'; host: string; failed: string }
  | { status: 'refused'; host: string | null; reason: string }

/** Verify one brand host (or report its existing state). Idempotent per host. */
export async function verifyBrandHost(brand: string, url: string, fetcher: Fetcher): Promise<VerifyOutcome> {
  const key = brandKey(brand)
  const host = httpsHostKey(url)
  if (!host) return { status: 'refused', host: null, reason: 'the product URL is not https' }
  if (isDenylisted(host)) return { status: 'refused', host, reason: `${host} is a retailer or review site` }

  const existing = await prisma.brandDomain.findUnique({ where: { host } })
  if (existing) {
    if (existing.brandKey !== key) return { status: 'refused', host, reason: `${host} belongs to ${existing.brand}` }
    if (existing.status === BrandDomainStatus.VERIFIED) return { status: 'verified', host }
    if (existing.status === BrandDomainStatus.REJECTED) return { status: 'refused', host, reason: `an admin rejected ${host} as ${brand}'s domain` }
    return { status: 'pending', host, failed: checkFailed(existing.checkResult) ?? 'waiting for an admin' }
  }

  const check: BrandCheck = {
    https: true, denylisted: false, labelContainsBrand: false, homepage: 'not_fetched', siteNames: [], siteNameMatches: false, failed: null,
  }
  const label = registrableLabel(host)
  check.labelContainsBrand = !!label && key.length > 0 && label.includes(key)
  if (!check.labelContainsBrand) {
    check.failed = `the domain name ${host} does not contain the brand name`
  } else {
    const home = await fetcher.fetch(`https://${host}/`, { kind: 'homepage', host }, ['html'])
    check.homepage = home.outcome
    if (home.outcome !== FetchOutcome.OK) {
      check.failed = `the home page could not be fetched (${home.outcome}: ${home.detail})`
    } else {
      const page = parseHtml(new TextDecoder().decode(home.body), home.url)
      check.siteNames = [...page.organizationNames, ...(page.siteName ? [page.siteName] : [])].slice(0, 10)
      check.siteNameMatches = check.siteNames.some((n) => siteNameMatches(n, brand))
      if (!check.siteNameMatches) {
        check.failed = check.siteNames.length
          ? `the home page names the site "${check.siteNames[0]}", not ${brand}`
          : 'the home page has no schema.org Organization or Brand name and no og:site_name'
      }
    }
  }
  const verified = check.failed === null
  const row = await prisma.brandDomain.upsert({
    where: { host },
    create: {
      brandKey: key, brand, host, checkResult: check as unknown as Prisma.InputJsonValue,
      status: verified ? BrandDomainStatus.VERIFIED : BrandDomainStatus.PENDING_CONFIRMATION,
      verifiedVia: verified ? BrandVerifiedVia.AUTOMATIC : null, verifiedAt: verified ? new Date() : null,
    },
    update: {},
  })
  logger.info('Brand domain checked', { host, brand: key, status: row.status, failed: check.failed })
  if (row.status === BrandDomainStatus.VERIFIED) return { status: 'verified', host }
  if (row.status === BrandDomainStatus.REJECTED) return { status: 'refused', host, reason: 'rejected by an admin' }
  return { status: 'pending', host, failed: check.failed ?? 'waiting for an admin' }
}

function checkFailed(json: Prisma.JsonValue | null): string | null {
  if (json && typeof json === 'object' && !Array.isArray(json) && typeof json.failed === 'string') return json.failed
  return null
}

/** Is this URL's host a verified domain of the brand? */
export async function isVerifiedFor(brand: string, url: string): Promise<boolean> {
  const host = httpsHostKey(url)
  if (!host) return false
  const row = await prisma.brandDomain.findUnique({ where: { host }, select: { brandKey: true, status: true } })
  return row !== null && row.status === BrandDomainStatus.VERIFIED && row.brandKey === brandKey(brand)
}

export { hostKey }
