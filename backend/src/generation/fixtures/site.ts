// The dry-run "internet": fixture pages served through the fetcher's transport interface, so every fetch
// rule still runs (docs/adr-generation-run.md D11).
import { hostKey } from '../fetch/hosts'
import { Transport, TransportResponse } from '../fetch/fetcher'
import { genericFixture } from './generic'
import { INFANT_CAR_SEATS } from './infantCarSeats'
import { makeTextPdf } from './pdf'
import { FixtureBrand, FixtureProduct, NodeFixture } from './types'

export function fixtureForSlug(slug: string): NodeFixture {
  return slug === INFANT_CAR_SEATS.slug ? INFANT_CAR_SEATS : genericFixture(slug)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const productUrl = (f: NodeFixture, p: FixtureProduct) => `https://${brandOf(f, p.brand).host}${p.path}`
export const manualUrl = (f: NodeFixture, p: FixtureProduct) => `${productUrl(f, p)}/manual.pdf`
export const scannedManualUrl = (f: NodeFixture, p: FixtureProduct) => `${productUrl(f, p)}/manual-scan.pdf`

function brandOf(f: NodeFixture, brand: string): FixtureBrand {
  const b = f.brands.find((x) => x.brand === brand)
  if (!b) throw new Error(`fixture brand ${brand} missing`)
  return b
}

export function specLine(f: NodeFixture, key: string, text: string): string {
  const label = f.levers.find((l) => l.key === key)?.label ?? key
  return `${label}: ${text}`
}

function homePage(b: FixtureBrand): string {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: b.siteName, url: `https://${b.host}/` })
  return `<!doctype html><html><head><title>${esc(b.siteName)}</title><meta property="og:site_name" content="${esc(b.siteName)}">`
    + `<script type="application/ld+json">${ld}</script></head><body><nav><a href="/">Home</a> <a href="/shop">Shop</a></nav>`
    + `<h1>${esc(b.siteName)}</h1><p>Welcome to ${esc(b.siteName)}.</p><footer>© ${esc(b.siteName)}</footer></body></html>`
}

function productPage(f: NodeFixture, p: FixtureProduct): string {
  const name = p.pageName ?? `${p.brand} ${p.model}`
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, brand: { '@type': 'Brand', name: p.brand } })
  const specs = Object.entries(p.specs).map(([k, v]) => `<li><strong>${esc(f.levers.find((l) => l.key === k)?.label ?? k)}:</strong> ${esc(v)}</li>`).join('')
  const manuals = [
    p.manual ? `<li><a href="${p.path}/manual.pdf">User manual (PDF)</a></li>` : '',
    p.scannedManual ? `<li><a href="${p.path}/manual-scan.pdf">Instructions (PDF)</a></li>` : '',
  ].join('')
  return `<!doctype html><html><head><title>${esc(name)} | ${esc(p.brand)}</title><script type="application/ld+json">${ld}</script></head>`
    + `<body><nav><a href="/">Home</a> <a href="/products">All products</a></nav><main><h1>${esc(name)}</h1>`
    + `<p>The ${esc(name)} ${esc(f.productType.toLowerCase())}.</p><h2>Specifications</h2><ul>${specs}</ul>`
    + (manuals ? `<h2>Downloads</h2><ul>${manuals}</ul>` : '')
    + `<img src="/images/${esc(p.model)}.jpg" alt="${esc(name)}"></main><footer>© ${esc(p.brand)}</footer></body></html>`
}

const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null })
const html = (body: string, status = 200): TransportResponse => ({ status, headers: headers({ 'content-type': 'text/html; charset=utf-8' }), body: new TextEncoder().encode(body), truncated: false })
const text = (body: string): TransportResponse => ({ status: 200, headers: headers({ 'content-type': 'text/plain' }), body: new TextEncoder().encode(body), truncated: false })
const pdf = (bytes: Uint8Array): TransportResponse => ({ status: 200, headers: headers({ 'content-type': 'application/pdf' }), body: bytes, truncated: false })
const notFound = (): TransportResponse => html('<html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>', 404)

/** Requests served, in order (the dry-run transcript prints them). */
export const fixtureRequestLog: { url: string; status: number }[] = []

export function fixtureTransport(): Transport {
  return async (req) => {
    const res = serve(req.url)
    fixtureRequestLog.push({ url: req.url, status: res.status })
    if (fixtureRequestLog.length > 1000) fixtureRequestLog.splice(0, fixtureRequestLog.length - 1000)
    return res
  }
}

function serve(rawUrl: string): TransportResponse {
  const url = new URL(rawUrl)
  const host = hostKey(url.hostname)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const slug = pathname.split('/')[1] ?? ''
  const fixtures = [INFANT_CAR_SEATS, ...(slug && slug !== 'products' ? [genericFixture(slug)] : []), genericFixture('generic')]
  for (const f of fixtures) {
    const brand = f.brands.find((b) => hostKey(b.host) === host)
    if (!brand) continue
    if (pathname === '/robots.txt') return text(brand.robots ?? 'User-agent: *\nAllow: /\n')
    if (pathname === '/') return html(homePage(brand))
    for (const p of f.products.filter((x) => x.brand === brand.brand)) {
      if (pathname === p.path) return p.status && p.status !== 200 ? html('<html><body>Forbidden</body></html>', p.status) : html(productPage(f, p))
      if (pathname === `${p.path}/manual.pdf` && p.manual) {
        const lines = ['Owner\'s manual', `${p.brand} ${p.model}`, ...Object.entries(p.manual).map(([k, v]) => specLine(f, k, v))]
        return pdf(makeTextPdf([lines, ['Installation', 'Read every instruction before installing the base in your vehicle.', 'Keep this manual with the seat.']]))
      }
      if (pathname === `${p.path}/manual-scan.pdf` && p.scannedManual) return pdf(makeTextPdf([[], []]))
    }
  }
  return notFound()
}
