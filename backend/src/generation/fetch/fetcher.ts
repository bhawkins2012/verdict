// The only code that requests third-party pages (docs/adr-generation-run.md D6, section 5 A1, A2). Every
// request, including robots.txt and every redirect hop, passes the same rules in this order:
//   https only → denylist → permit (allow-list) → host not paused after a block → robots.txt →
//   1 request per second per host (database clock, so it holds across instances) → GET.
// No cookies are kept and no credentials are sent; 401/403/429 or a challenge page stops the fetch and
// pauses the host for 24 hours: blocks are never worked around.
import { BrandDomainStatus, FetchOutcome } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { resolveFrontendUrl } from '../../lib/frontendUrl'
import { hostKey, httpsHostKey, isDenylisted } from './hosts'
import { decideRobots, ROBOTS_TTL_MS, RobotsStatus, USER_AGENT_TOKEN } from './robots'

export const MIN_GAP_MS = 1000
export const REQUEST_TIMEOUT_MS = 15_000
export const MAX_REDIRECTS = 5
export const MAX_HTML_BYTES = 3 * 1024 * 1024
export const MAX_PDF_BYTES = 15 * 1024 * 1024
export const BLOCK_PAUSE_MS = 24 * 60 * 60 * 1000
export const RETRY_DELAY_MS = 30_000

export function userAgent(): string {
  return `${USER_AGENT_TOKEN}/1.0 (+${resolveFrontendUrl().url}/bot)`
}

// ── Transport (injected in tests and dry runs) ──────────────────────────────────────────────────────
export interface TransportRequest { url: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number }
export interface TransportResponse { status: number; headers: { get(name: string): string | null }; body: Uint8Array; truncated: boolean }
/** Throws on a network error or timeout; never follows redirects (the fetcher checks every hop). */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export const networkTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: 'GET', redirect: 'manual', headers: req.headers, signal: AbortSignal.timeout(req.timeoutMs) })
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > req.maxBytes) { truncated = true; await reader.cancel(); break }
      chunks.push(value)
    }
  }
  const body = new Uint8Array(Math.min(size, req.maxBytes))
  let at = 0
  for (const c of chunks) { body.set(c.subarray(0, body.length - at), at); at += c.byteLength; if (at >= body.length) break }
  return { status: res.status, headers: res.headers, body, truncated }
}

// ── Permits: why a URL may be fetched ───────────────────────────────────────────────────────────────
export type Permit =
  /** Brand verification: only https://<host>/ (and redirects on the same host). */
  | { kind: 'homepage'; host: string }
  /** A verified host of this brand (product pages, manual values). */
  | { kind: 'brand'; brandKey: string }
  /** A PDF linked from the product's page (any non-denylisted host), or on a verified host of the brand. */
  | { kind: 'linked'; brandKey: string; urls: ReadonlySet<string> }

export type ContentKind = 'html' | 'pdf'

export type FetchResult =
  | { outcome: typeof FetchOutcome.OK; url: string; host: string; status: number; kind: ContentKind; body: Uint8Array }
  | { outcome: Exclude<FetchOutcome, 'OK' | 'SCANNED_PDF'>; url: string; host: string | null; status: number | null; detail: string }

export interface FetcherDeps {
  transport: Transport
  now: () => number
  sleep: (ms: number) => Promise<void>
  retryDelayMs: number
}

export const realDeps = (transport: Transport = networkTransport): FetcherDeps => ({
  transport,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  retryDelayMs: RETRY_DELAY_MS,
})

async function isVerifiedHost(host: string, brandKey: string): Promise<boolean> {
  const row = await prisma.brandDomain.findFirst({ where: { host, brandKey, status: BrandDomainStatus.VERIFIED }, select: { id: true } })
  return row !== null
}

/** The permit's rule for one hop (`prevHost`: the host of the hop that redirected here, if any). */
async function permitted(permit: Permit, url: URL, host: string, prevHost: string | null): Promise<string | null> {
  switch (permit.kind) {
    case 'homepage':
      if (host !== hostKey(permit.host)) return 'only the brand host itself may be fetched for verification'
      if (prevHost === null && url.pathname !== '/') return 'brand verification fetches only the home page'
      return null
    case 'brand':
      return (await isVerifiedHost(host, permit.brandKey)) ? null : `${host} is not a verified domain of this brand`
    case 'linked':
      if (prevHost === null && permit.urls.has(url.toString())) return null
      if (prevHost !== null && host === prevHost) return null
      return (await isVerifiedHost(host, permit.brandKey)) ? null : `${host} is neither linked from the product page nor a verified domain of this brand`
  }
}

export class Fetcher {
  constructor(private readonly deps: FetcherDeps) {}

  /** Fetch one document under a permit. Never throws for remote failures: they are outcomes. */
  async fetch(rawUrl: string, permit: Permit, accept: readonly ContentKind[]): Promise<FetchResult> {
    let url = rawUrl
    let prevHost: string | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = httpsHostKey(url)
      if (!host) return { outcome: FetchOutcome.NOT_ALLOWED, url, host: null, status: null, detail: 'only https URLs are fetched' }
      if (isDenylisted(host)) return { outcome: FetchOutcome.NOT_ALLOWED, url, host, status: null, detail: `${host} is a retailer or review site` }
      const parsed = new URL(url)
      const refusal = await permitted(permit, parsed, host, prevHost)
      if (refusal) return { outcome: FetchOutcome.NOT_ALLOWED, url, host, status: null, detail: refusal }
      const paused = await this.pausedUntil(host)
      if (paused) return { outcome: FetchOutcome.BLOCKED, url, host, status: null, detail: `host paused after a block until ${paused.toISOString()}` }
      const robots = await this.robots(host, url)
      if (!robots.allowed) return { outcome: FetchOutcome.ROBOTS_DISALLOWED, url, host, status: null, detail: 'robots.txt disallows this URL' }

      const res = await this.request(host, url, accept, 1)
      if ('error' in res) return { outcome: FetchOutcome.NETWORK, url, host, status: null, detail: res.error }
      const { status } = res
      if (status >= 300 && status < 400) {
        const location = res.headers.get('location')
        if (!location) return { outcome: FetchOutcome.HTTP_ERROR, url, host, status, detail: 'redirect without a location' }
        prevHost = host
        url = new URL(location, url).toString()
        continue
      }
      if (status === 401 || status === 403 || status === 429 || res.headers.get('cf-mitigated') !== null) {
        await this.pause(host)
        return { outcome: FetchOutcome.BLOCKED, url, host, status, detail: `the site refused the request (${status}); not retried` }
      }
      if (status < 200 || status >= 300) return { outcome: FetchOutcome.HTTP_ERROR, url, host, status, detail: `HTTP ${status}` }
      if (res.truncated) return { outcome: FetchOutcome.TOO_LARGE, url, host, status, detail: 'larger than the size limit' }
      const kind = contentKind(res.headers.get('content-type'))
      if (!kind || !accept.includes(kind)) {
        return { outcome: FetchOutcome.UNSUPPORTED_TYPE, url, host, status, detail: `content type ${res.headers.get('content-type') ?? 'unknown'}` }
      }
      return { outcome: FetchOutcome.OK, url, host, status, kind, body: res.body }
    }
    return { outcome: FetchOutcome.HTTP_ERROR, url, host: null, status: null, detail: 'too many redirects' }
  }

  /** Mark a host blocked (a challenge page found by the caller after parsing). */
  async pause(host: string): Promise<void> {
    const until = new Date(this.deps.now() + BLOCK_PAUSE_MS)
    await this.ensureHost(host)
    await prisma.fetchHost.update({ where: { host }, data: { blockedUntil: until } })
  }

  private async pausedUntil(host: string): Promise<Date | null> {
    const row = await prisma.fetchHost.findUnique({ where: { host }, select: { blockedUntil: true } })
    return row?.blockedUntil && row.blockedUntil.getTime() > this.deps.now() ? row.blockedUntil : null
  }

  private async ensureHost(host: string): Promise<void> {
    await prisma.$executeRaw`INSERT INTO "fetch_hosts" ("host", "updatedAt") VALUES (${host}, now()) ON CONFLICT ("host") DO NOTHING`
  }

  /**
   * Claim the next request slot for a host: lock its row, take max(now, last + gap), store it, commit, then
   * sleep outside the transaction. Two requests to one host are always at least the gap apart, in any process.
   */
  private async waitForSlot(host: string): Promise<void> {
    await this.ensureHost(host)
    const wait = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ lastFetchAt: Date | null; crawlDelaySec: number | null }[]>`
        SELECT "lastFetchAt", "crawlDelaySec" FROM "fetch_hosts" WHERE "host" = ${host} FOR UPDATE`
      const gap = Math.max(MIN_GAP_MS, (rows[0]?.crawlDelaySec ?? 0) * 1000)
      const now = this.deps.now()
      const last = rows[0]?.lastFetchAt?.getTime() ?? null
      const next = last === null ? now : Math.max(now, last + gap)
      await tx.fetchHost.update({ where: { host }, data: { lastFetchAt: new Date(next) } })
      return next - now
    })
    if (wait > 0) await this.deps.sleep(wait)
  }

  private async request(host: string, url: string, accept: readonly ContentKind[], retries: number): Promise<TransportResponse | { error: string }> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot(host)
      try {
        const res = await this.deps.transport({
          url,
          headers: {
            'User-Agent': userAgent(),
            Accept: [accept.includes('html') ? 'text/html,application/xhtml+xml' : null, accept.includes('pdf') ? 'application/pdf' : null, 'text/plain;q=0.1']
              .filter(Boolean).join(','),
          },
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxBytes: accept.includes('pdf') ? MAX_PDF_BYTES : MAX_HTML_BYTES,
        })
        if (res.status >= 500 && attempt < retries) { await this.deps.sleep(this.deps.retryDelayMs); continue }
        return res
      } catch (err) {
        if (attempt < retries) { await this.deps.sleep(this.deps.retryDelayMs); continue }
        return { error: err instanceof Error ? err.name : 'network error' }
      }
    }
  }

  /** robots.txt for a host, cached 24 h in fetch_hosts (D6.4). */
  private async robots(host: string, url: string): Promise<{ allowed: boolean }> {
    await this.ensureHost(host)
    let row = await prisma.fetchHost.findUnique({ where: { host } })
    const fresh = row?.robotsFetchedAt && this.deps.now() - row.robotsFetchedAt.getTime() < ROBOTS_TTL_MS && row.robotsStatus
    if (!fresh) {
      const { status, text } = await this.fetchRobots(host)
      const decided = status === 'ok' ? decideRobots(status, text, url) : null
      row = await prisma.fetchHost.update({
        where: { host },
        data: { robotsStatus: status, robotsTxt: text, robotsFetchedAt: new Date(this.deps.now()), crawlDelaySec: decided?.crawlDelaySec ?? null },
      })
    }
    const status = (row?.robotsStatus ?? 'disallow_all') as RobotsStatus
    return { allowed: decideRobots(status, row?.robotsTxt ?? null, url).allowed }
  }

  private async fetchRobots(host: string): Promise<{ status: RobotsStatus; text: string | null }> {
    let url = `https://${host}/robots.txt`
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const h = httpsHostKey(url)
      if (!h || isDenylisted(h)) return { status: 'disallow_all', text: null }
      await this.ensureHost(h)
      const res = await this.request(h, url, [], 0)
      if ('error' in res) return { status: 'disallow_all', text: null }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { status: 'disallow_all', text: null }
        url = new URL(loc, url).toString()
        continue
      }
      if (res.status >= 200 && res.status < 300) return { status: 'ok', text: new TextDecoder().decode(res.body).slice(0, 500_000) }
      if (res.status >= 400 && res.status < 500) return { status: 'allow_all', text: null }
      return { status: 'disallow_all', text: null }
    }
    return { status: 'disallow_all', text: null }
  }
}

export function contentKind(contentType: string | null): ContentKind | null {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
  if (ct === 'application/pdf') return 'pdf'
  return null
}

// ── The process-wide fetcher (live: the network; dry run and tests: injected) ──────────────────────
let override: Fetcher | null = null
export function setFetcherForTests(f: Fetcher | null): void { override = f }
export function fetcherFor(mode: 'live' | 'dry_run', dryRunTransport: () => Transport): Fetcher {
  if (override) return override
  if (mode === 'live') {
    if (process.env.NODE_ENV === 'test') throw new Error('Tests must inject a fetcher (setFetcherForTests)')
    return new Fetcher(realDeps())
  }
  return new Fetcher(realDeps(dryRunTransport()))
}
