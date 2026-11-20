// The fetcher's rules (docs/adr-generation-run.md D6): allow-list, denylist, robots.txt, rate limit, blocks.
import { prisma } from '../../src/lib/prisma'
import { FetchOutcome } from '@prisma/client'
import { BLOCK_PAUSE_MS, MIN_GAP_MS } from '../../src/generation/fetch/fetcher'
import { FakeWeb, forgetHosts, uid, verifiedBrand } from './helpers'

const hosts: string[] = []
afterAll(() => forgetHosts(hosts))

function setup(opts: { verified?: boolean } = {}) {
  const host = `acme-${uid()}.example`
  hosts.push(host)
  const web = new FakeWeb()
  web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
  web.page(`https://${host}/p`, '<html><head><title>Acme P</title></head><body><h1>Acme P</h1></body></html>')
  return { host, web, fetcher: web.fetcher(), ready: opts.verified === false ? Promise.resolve() : verifiedBrand('Acme', host).then(() => undefined) }
}

const brand = { kind: 'brand', brandKey: 'acme' } as const

describe('allow-list', () => {
  it('refuses a host that is not a verified domain of the brand, without any request', async () => {
    const { host, web, fetcher } = setup({ verified: false })
    const r = await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.NOT_ALLOWED)
    expect(web.requests).toHaveLength(0)
  })

  it('fetches a verified host of the brand (robots.txt first)', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    const r = await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.OK)
    expect(web.urls()).toEqual([`https://${host}/robots.txt`, `https://${host}/p`])
  })

  it('treats www. and the bare host as one', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.page(`https://www.${host}/p`, '<html><body>ok</body></html>')
    web.set(`https://www.${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
    expect((await fetcher.fetch(`https://www.${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.OK)
  })

  it('a verified host of another brand is not allowed for this brand', async () => {
    const { host, fetcher, ready } = setup()
    await ready
    expect((await fetcher.fetch(`https://${host}/p`, { kind: 'brand', brandKey: 'otherbrand' }, ['html'])).outcome).toBe(FetchOutcome.NOT_ALLOWED)
  })

  it('stops at a redirect to a host that is not allowed', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/moved`, { status: 301, headers: { location: 'https://elsewhere.example/p' } })
    const r = await fetcher.fetch(`https://${host}/moved`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.NOT_ALLOWED)
    expect(web.urls().some((u) => u.includes('elsewhere.example'))).toBe(false)
  })

  it('follows a redirect on the same verified host', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/old`, { status: 301, headers: { location: '/p' } })
    expect((await fetcher.fetch(`https://${host}/old`, brand, ['html'])).outcome).toBe(FetchOutcome.OK)
  })

  it('refuses http, and denylisted retailers even when "verified"', async () => {
    const { host, fetcher, web, ready } = setup()
    await ready
    expect((await fetcher.fetch(`http://${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.NOT_ALLOWED)
    await verifiedBrand('Amazon', 'amazon.com')
    hosts.push('amazon.com')
    const r = await fetcher.fetch('https://www.amazon.com/dp/B000', { kind: 'brand', brandKey: 'amazon' }, ['html'])
    expect(r.outcome).toBe(FetchOutcome.NOT_ALLOWED)
    expect(web.requests).toHaveLength(0)
  })

  it('home-page permit: only https://<host>/', async () => {
    const { host, web, fetcher } = setup({ verified: false })
    web.page(`https://${host}/`, '<html><body>home</body></html>')
    expect((await fetcher.fetch(`https://${host}/`, { kind: 'homepage', host }, ['html'])).outcome).toBe(FetchOutcome.OK)
    expect((await fetcher.fetch(`https://${host}/p`, { kind: 'homepage', host }, ['html'])).outcome).toBe(FetchOutcome.NOT_ALLOWED)
  })

  it('linked permit: a URL linked from the page, on any non-denylisted host; nothing else', async () => {
    const { web, fetcher } = setup({ verified: false })
    const cdn = `cdn-${uid()}.example`
    hosts.push(cdn)
    web.set(`https://${cdn}/manual.pdf`, { type: 'application/pdf', body: '%PDF-1.4' })
    const urls = new Set([`https://${cdn}/manual.pdf`])
    expect((await fetcher.fetch(`https://${cdn}/manual.pdf`, { kind: 'linked', brandKey: 'acme', urls }, ['pdf'])).outcome).toBe(FetchOutcome.OK)
    expect((await fetcher.fetch(`https://${cdn}/other.pdf`, { kind: 'linked', brandKey: 'acme', urls }, ['pdf'])).outcome).toBe(FetchOutcome.NOT_ALLOWED)
  })
})

describe('robots.txt', () => {
  it('a disallowed URL is never requested', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nDisallow: /p\n' })
    const r = await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.ROBOTS_DISALLOWED)
    expect(web.urls()).toEqual([`https://${host}/robots.txt`])
  })

  it('rules for our token apply', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: VerdictBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' })
    expect((await fetcher.fetch(`https://${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.ROBOTS_DISALLOWED)
  })

  it('4xx robots.txt allows all; 5xx or a network error disallows all (RFC 9309)', async () => {
    const a = setup(); await a.ready
    a.web.set(`https://${a.host}/robots.txt`, { status: 404, type: 'text/plain', body: '' })
    expect((await a.fetcher.fetch(`https://${a.host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.OK)
    const b = setup(); await b.ready
    b.web.set(`https://${b.host}/robots.txt`, { status: 503, type: 'text/plain', body: '' })
    expect((await b.fetcher.fetch(`https://${b.host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.ROBOTS_DISALLOWED)
    const c = setup(); await c.ready
    c.web.set(`https://${c.host}/robots.txt`, { status: -1 })
    expect((await c.fetcher.fetch(`https://${c.host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.ROBOTS_DISALLOWED)
  })

  it('is cached for 24 hours', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(web.urls().filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1)
  })
})

describe('rate limit and request rules', () => {
  it('waits at least a second between requests to one host', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    // robots.txt at t, the page at t+1s, the page again at t+2s: every gap is at least MIN_GAP_MS.
    const row = await prisma.fetchHost.findUniqueOrThrow({ where: { host } })
    expect(web.sleeps.length).toBeGreaterThanOrEqual(2)
    expect(web.sleeps.every((s) => s >= MIN_GAP_MS)).toBe(true)
    expect(row.lastFetchAt?.getTime()).toBeGreaterThanOrEqual(web.clock - 1)
  })

  it('honours a longer Crawl-delay', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 3\nAllow: /\n' })
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(web.sleeps[web.sleeps.length - 1]).toBeGreaterThanOrEqual(3000)
  })

  it('sends our user agent and no cookies', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/p`, { body: '<html><body>x</body></html>', headers: { 'set-cookie': 'session=abc' } })
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    for (const r of web.requests) {
      expect(r.headers['User-Agent']).toMatch(/^VerdictBot\/1\.0 \(\+.*\/bot\)$/)
      expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('cookie')
      expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('authorization')
    }
  })

  it.each([401, 403, 429])('%i: blocked, not retried, and the host is paused for 24 hours', async (status) => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/p`, { status })
    const r = await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.BLOCKED)
    expect(web.urls().filter((u) => u.endsWith('/p'))).toHaveLength(1)
    const row = await prisma.fetchHost.findUniqueOrThrow({ where: { host } })
    expect(row.blockedUntil?.getTime()).toBe(web.clock + BLOCK_PAUSE_MS)
    // While paused: no request at all.
    const before = web.requests.length
    expect((await fetcher.fetch(`https://${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.BLOCKED)
    expect(web.requests.length).toBe(before)
  })

  it('a challenge header blocks too', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/p`, { status: 200, headers: { 'cf-mitigated': 'challenge' } })
    expect((await fetcher.fetch(`https://${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.BLOCKED)
  })

  it('5xx is retried once, then reported', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/p`, { status: 503 })
    const r = await fetcher.fetch(`https://${host}/p`, brand, ['html'])
    expect(r.outcome).toBe(FetchOutcome.HTTP_ERROR)
    expect(web.urls().filter((u) => u.endsWith('/p'))).toHaveLength(2)
  })

  it('an unexpected content type is not used', async () => {
    const { host, web, fetcher, ready } = setup()
    await ready
    web.set(`https://${host}/p`, { type: 'image/jpeg', body: 'jpeg' })
    expect((await fetcher.fetch(`https://${host}/p`, brand, ['html'])).outcome).toBe(FetchOutcome.UNSUPPORTED_TYPE)
  })
})
