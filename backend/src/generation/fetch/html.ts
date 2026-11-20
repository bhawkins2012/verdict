// HTML to text and the page facts the checks need (docs/adr-generation-run.md D6.6, section 5 A1):
// visible text (no scripts, styles, navigation, footers, forms or images), the <title>, <h1>s,
// schema.org names from JSON-LD, og:site_name, and links (for PDF manuals).
import { Parser } from 'htmlparser2'

export interface ParsedPage {
  text: string
  title: string | null
  h1s: string[]
  siteName: string | null
  /** schema.org Organization / Corporation / Brand names (JSON-LD) */
  organizationNames: string[]
  /** schema.org Product names (JSON-LD) */
  productNames: string[]
  links: { url: string; text: string }[]
}

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'footer', 'head', 'select', 'textarea', 'button', 'form', 'img', 'picture', 'video', 'audio', 'canvas', 'object'])
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'main', 'aside', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'tr', 'tbody', 'thead', 'tfoot', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'blockquote', 'pre', 'figure', 'figcaption', 'caption'])
const CELL = new Set(['td', 'th'])
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'])

const ORG_TYPES = new Set(['organization', 'corporation', 'brand', 'onlinestore', 'store'])

function collectJsonLd(node: unknown, page: ParsedPage, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLd(n, page, depth + 1)
    return
  }
  const obj = node as Record<string, unknown>
  const rawType = obj['@type']
  const types = (Array.isArray(rawType) ? rawType : [rawType]).filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())
  const name = typeof obj.name === 'string' ? obj.name.trim() : null
  if (name && types.some((t) => ORG_TYPES.has(t))) page.organizationNames.push(name)
  if (name && types.includes('product')) page.productNames.push(name)
  for (const key of ['@graph', 'brand', 'manufacturer', 'publisher', 'mainEntity', 'itemListElement', 'item']) {
    if (key in obj) collectJsonLd(obj[key], page, depth + 1)
  }
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const page: ParsedPage = { text: '', title: null, h1s: [], siteName: null, organizationNames: [], productNames: [], links: [] }
  const out: string[] = []
  const stack: string[] = []
  let skipDepth = 0
  let inTitle = false
  let titleText = ''
  let h1Depth = 0
  let h1Text = ''
  let jsonLd: string | null = null
  let link: { href: string; text: string } | null = null

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase()
        if (tag === 'meta') {
          const prop = (attrs.property ?? attrs.name ?? '').toLowerCase()
          if (prop === 'og:site_name' && attrs.content && !page.siteName) page.siteName = attrs.content.trim()
          return
        }
        if (tag === 'title') { inTitle = true; return }
        if (tag === 'script') {
          if ((attrs.type ?? '').toLowerCase().includes('ld+json')) jsonLd = ''
        }
        if (!VOID.has(tag)) stack.push(tag)
        if (SKIP.has(tag) && !VOID.has(tag)) skipDepth++
        if (skipDepth > 0) return
        if (tag === 'h1') { h1Depth++; h1Text = '' }
        if (tag === 'a' && attrs.href) link = { href: attrs.href, text: '' }
        if (BLOCK.has(tag)) out.push('\n')
        if (CELL.has(tag)) out.push(' | ')
      },
      ontext(data) {
        if (inTitle) { titleText += data; return }
        if (jsonLd !== null) { jsonLd += data; return }
        if (skipDepth > 0) return
        out.push(data)
        if (h1Depth > 0) h1Text += data
        if (link) link.text += data
      },
      onclosetag(name) {
        const tag = name.toLowerCase()
        if (tag === 'title') { inTitle = false; page.title = titleText.replace(/\s+/g, ' ').trim() || null; return }
        if (tag === 'script' && jsonLd !== null) {
          try { collectJsonLd(JSON.parse(jsonLd), page) } catch { /* not JSON: ignored */ }
          jsonLd = null
        }
        if (VOID.has(tag)) { if (tag === 'br' && skipDepth === 0) out.push('\n'); return }
        // Pop to the matching open tag (forgiving of unclosed children).
        const at = stack.lastIndexOf(tag)
        if (at === -1) return
        for (const popped of stack.splice(at)) {
          if (SKIP.has(popped)) skipDepth = Math.max(0, skipDepth - 1)
        }
        if (skipDepth > 0) return
        if (tag === 'h1' && h1Depth > 0) {
          h1Depth--
          const t = h1Text.replace(/\s+/g, ' ').trim()
          if (t) page.h1s.push(t)
        }
        if (tag === 'a' && link) {
          try {
            page.links.push({ url: new URL(link.href, baseUrl).toString(), text: link.text.replace(/\s+/g, ' ').trim() })
          } catch { /* bad href: ignored */ }
          link = null
        }
        if (BLOCK.has(tag)) out.push('\n')
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  )
  parser.write(html)
  parser.end()

  page.text = out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s*\|\s*/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n')
  return page
}

/** Does a page look like a bot challenge rather than content? (D6.5: stop, never bypass.) */
export function looksLikeChallenge(page: ParsedPage, html: string): boolean {
  const sample = `${page.title ?? ''} ${page.text.slice(0, 2000)}`.toLowerCase()
  return /captcha|are you a robot|verify you are human|access denied|attention required|checking your browser/.test(sample)
    || /cf-challenge|challenge-platform|g-recaptcha|h-captcha/.test(html.slice(0, 50_000).toLowerCase())
}

/**
 * The text sent to the model: all of it when short, otherwise the start of the page plus the part from the
 * first specifications heading, so spec tables low on a long page are included.
 */
export function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.2)
  const m = /(specifications|specs|technical details|dimensions|product details|features)/i.exec(text.slice(head))
  if (!m) return text.slice(0, maxChars)
  const at = head + m.index
  return `${text.slice(0, head)}\n…\n${text.slice(at, at + maxChars - head)}`
}
