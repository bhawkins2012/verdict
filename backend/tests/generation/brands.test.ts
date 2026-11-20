// Brand domains (section 5 A1) and the page facts the checks use (HTML, PDF).
import { BrandDomainStatus } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { siteNameMatches, verifyBrandHost } from '../../src/generation/brands'
import { parseHtml, looksLikeChallenge } from '../../src/generation/fetch/html'
import { extractPdfText } from '../../src/generation/fetch/pdf'
import { makeTextPdf } from '../../src/generation/fixtures/pdf'
import { isDenylisted, registrableLabel } from '../../src/generation/fetch/hosts'
import { FakeWeb, forgetHosts, homePage, uid } from './helpers'

const hosts: string[] = []
afterAll(() => forgetHosts(hosts))

function site(brand: string, host: string, siteName: string, opts: { ld?: boolean } = {}) {
  hosts.push(host)
  const web = new FakeWeb()
  web.set(`https://${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
  web.page(`https://${host}/`, homePage(siteName, opts))
  return web
}

describe('automatic brand verification', () => {
  it('verifies a host whose domain contains the brand and whose home page names it', async () => {
    const id = uid()
    const host = `lullacarry${id}.example`
    const web = site(`LullaCarry${id}`, host, `LullaCarry${id}`)
    web.set(`https://www.${host}/robots.txt`, { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' })
    web.page(`https://www.${host}/`, homePage(`LullaCarry${id}`))
    const r = await verifyBrandHost(`LullaCarry${id}`, `https://www.${host}/products/glide`, web.fetcher())
    expect(r).toEqual({ status: 'verified', host })
    const row = await prisma.brandDomain.findUniqueOrThrow({ where: { host } })
    expect(row).toMatchObject({ status: BrandDomainStatus.VERIFIED, verifiedVia: 'AUTOMATIC' })
    // Only robots.txt and the home page were requested, from the origin the product URL names (www. kept).
    expect(web.urls()).toEqual([`https://www.${host}/robots.txt`, `https://www.${host}/`])
  })

  it('a lookalike domain (brand in the name, another site name) waits for an admin', async () => {
    const id = uid()
    const host = `petalpod${id}-deals.example`
    const web = site(`Petalpod${id}`, host, 'Deal Depot')
    const r = await verifyBrandHost(`Petalpod${id}`, `https://${host}/shop/bloom`, web.fetcher())
    expect(r.status).toBe('pending')
    expect(r.status === 'pending' && r.failed).toMatch(/Deal Depot/)
    expect((await prisma.brandDomain.findUniqueOrThrow({ where: { host } })).status).toBe(BrandDomainStatus.PENDING_CONFIRMATION)
  })

  it('a domain without the brand name waits for an admin, and its home page is not fetched', async () => {
    const id = uid()
    const host = `kidsgear${id}.example`
    const web = site(`Brightway${id}`, host, `Brightway${id}`)
    const r = await verifyBrandHost(`Brightway${id}`, `https://${host}/p`, web.fetcher())
    expect(r.status).toBe('pending')
    expect(web.requests).toHaveLength(0)
  })

  it('a home page without a schema.org or og:site_name name waits for an admin', async () => {
    const id = uid()
    const host = `nestwell${id}.example`
    hosts.push(host)
    const web = new FakeWeb()
    web.page(`https://${host}/`, '<html><head><title>Nestwell</title></head><body>Hi</body></html>')
    expect((await verifyBrandHost(`Nestwell${id}`, `https://${host}/p`, web.fetcher())).status).toBe('pending')
  })

  it('a denylisted host is refused outright and never offered for confirmation', async () => {
    const web = new FakeWeb()
    const r = await verifyBrandHost('Amazon', 'https://www.amazon.com/dp/B0', web.fetcher())
    expect(r.status).toBe('refused')
    expect(await prisma.brandDomain.findUnique({ where: { host: 'amazon.com' } })).toBeNull()
    expect(web.requests).toHaveLength(0)
  })

  it('a marketplace subdomain never passes the domain check (private suffixes count as public)', () => {
    expect(registrableLabel('graco.myshopify.com')).toBe('myshopify')
    expect(registrableLabel('www.maxi-cosi.co.uk')).toBe('maxicosi')
    expect(isDenylisted('www.amazon.co.uk')).toBe(true)
    expect(isDenylisted('graco.example')).toBe(false)
  })

  it('site names match the brand after normalization, ignoring generic words', () => {
    expect(siteNameMatches('Graco Baby', 'Graco')).toBe(true)
    expect(siteNameMatches('UPPAbaby', 'UPPAbaby')).toBe(true)
    expect(siteNameMatches('Maxi-Cosi US', 'Maxi-Cosi')).toBe(true)
    expect(siteNameMatches('Uppababy Deals', 'UPPAbaby')).toBe(false)
    expect(siteNameMatches('Deal Depot', 'Petalpod')).toBe(false)
    expect(siteNameMatches('Baby', 'Graco')).toBe(false)
  })
})

describe('page facts', () => {
  const html = `<!doctype html><html><head><title>Acme Glide | Acme</title><meta property="og:site_name" content="Acme">
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Acme Inc"},{"@type":"Product","name":"Acme Glide","brand":{"@type":"Brand","name":"Acme"}}]}</script>
    <style>.x{}</style></head><body><nav>Shop 99 lb</nav><header>Free shipping</header><main><h1>Acme <b>Glide</b></h1>
    <script>var weight = "1 lb"</script><img src="a.jpg" alt="photo"><table><tr><th>Weight</th><td>9.5&nbsp;lb</td></tr></table>
    <p>Fits &amp; folds.</p><a href="/manual.pdf">User manual (PDF)</a><form><input value="secret"><button>Buy</button></form></main><footer>© 2026</footer></body></html>`

  it('keeps visible text only, with tables readable, and reads the names and links', () => {
    const p = parseHtml(html, 'https://acme.example/glide')
    expect(p.title).toBe('Acme Glide | Acme')
    expect(p.h1s).toEqual(['Acme Glide'])
    expect(p.siteName).toBe('Acme')
    expect(p.organizationNames).toEqual(expect.arrayContaining(['Acme Inc', 'Acme']))
    expect(p.productNames).toEqual(['Acme Glide'])
    expect(p.links).toEqual([{ url: 'https://acme.example/manual.pdf', text: 'User manual (PDF)' }])
    expect(p.text).toContain('Weight | 9.5 lb')
    expect(p.text).toContain('Fits & folds.')
    for (const hidden of ['Shop 99 lb', 'var weight', '.x{}', 'photo', 'secret', 'Buy', '© 2026']) expect(p.text).not.toContain(hidden)
  })

  it('recognises a challenge page', () => {
    const p = parseHtml('<html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1></body></html>', 'https://x.example/')
    expect(looksLikeChallenge(p, '')).toBe(true)
    expect(looksLikeChallenge(parseHtml(html, 'https://acme.example/'), html)).toBe(false)
  })

  it('reads text-based PDFs in a separate process and skips scanned ones', async () => {
    const text = await extractPdfText(makeTextPdf([['Owner manual', 'Maximum child height: 32 in'], ['Keep this manual with the seat and read it before use.']]))
    expect(text.ok && text.text).toContain('Maximum child height: 32 in')
    expect(await extractPdfText(makeTextPdf([[], []]))).toEqual({ ok: false, reason: 'scanned' })
    expect(await extractPdfText(new TextEncoder().encode('not a pdf'))).toEqual({ ok: false, reason: 'parse_failed' })
  }, 30_000)
})
