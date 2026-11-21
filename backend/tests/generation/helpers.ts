// Test helpers for the catalog and the generation run. Every test builds its own small taxonomy under a
// unique root and uses unique `.example` hosts, so suites never depend on each other or on the launch nodes.
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  AcceptMode, BrandDomainStatus, BrandVerifiedVia, CatalogStatus, Confidence, LeverInputFormat, LeverOrigin, LeverType, NodeKind,
  UserRole, ValueOrigin, ValueStatus,
} from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { registerUser } from '../helpers'
import { Fetcher, Transport, TransportResponse, setFetcherForTests } from '../../src/generation/fetch/fetcher'
import { GenerationModel, ModelResult, setGenerationModelForTests } from '../../src/generation/model'
import { normalizeName } from '../../src/catalog/text'

export const uid = () => randomUUID().slice(0, 8)

export async function registerAdmin() {
  const user = await registerUser()
  await prisma.user.update({ where: { id: user.id }, data: { role: UserRole.ADMIN } })
  return user
}

// ── Taxonomy ────────────────────────────────────────────────────────────────────────────────────────
export interface TestTree { rootId: string; navId: string; nodeId: string; otherNodeId: string; slug: string; ids: string[] }

/** root (navigation) › nav (navigation) › node, otherNode (decision). */
export async function testTree(opts: { safety?: boolean } = {}): Promise<TestTree> {
  const s = uid()
  const root = await prisma.taxonomyNode.create({ data: { slug: `t-root-${s}`, name: `Root ${s}`, kind: NodeKind.NAVIGATION, searchTerms: [] } })
  const nav = await prisma.taxonomyNode.create({ data: { slug: `t-nav-${s}`, name: `Nav ${s}`, kind: NodeKind.NAVIGATION, parentId: root.id, searchTerms: [], safetyCritical: !!opts.safety } })
  const node = await prisma.taxonomyNode.create({ data: { slug: `t-node-${s}`, name: `Things ${s}`, kind: NodeKind.DECISION, parentId: nav.id, searchTerms: [`thing ${s}`] } })
  const other = await prisma.taxonomyNode.create({ data: { slug: `t-other-${s}`, name: `Others ${s}`, kind: NodeKind.DECISION, parentId: nav.id, searchTerms: [] } })
  return { rootId: root.id, navId: nav.id, nodeId: node.id, otherNodeId: other.id, slug: node.slug, ids: [other.id, node.id, nav.id, root.id] }
}

export async function deleteTree(t: TestTree | undefined) {
  if (!t) return
  await prisma.product.deleteMany({ where: { OR: [{ nodeId: { in: t.ids } }, { discoveredByRun: { nodeId: { in: t.ids } } }] } })
  await prisma.nodeSecondaryParent.deleteMany({ where: { OR: [{ nodeId: { in: t.ids } }, { parentId: { in: t.ids } }] } })
  for (const id of t.ids) await prisma.taxonomyNode.delete({ where: { id } }).catch(() => undefined)
}

// ── Levers and values ───────────────────────────────────────────────────────────────────────────────
export interface DefSpec { name: string; type: LeverType; unit: string | null; inputFormat?: LeverInputFormat; allowedValues?: string[]; safetyFlag?: boolean }

export const FIVE: DefSpec[] = [
  { name: 'Weight', type: LeverType.MEASUREMENT, unit: 'lb' },
  { name: 'Width', type: LeverType.MEASUREMENT, unit: 'in' },
  { name: 'Compatibility', type: LeverType.COMPATIBILITY_LIST, unit: null },
  { name: 'Wheel material', type: LeverType.CATEGORY, unit: null, allowedValues: ['Rubber', 'Foam-filled', 'Plastic'] },
  { name: 'Has canopy', type: LeverType.BOOLEAN, unit: null },
]

/** Candidate levers on a node, with definitions named "<name> <suffix>" (unique per test). */
export async function addLevers(nodeId: string, specs: DefSpec[] = FIVE, suffix = uid()) {
  const out = []
  for (const s of specs) {
    const name = `${s.name} ${suffix}`
    const def = await prisma.leverDefinition.create({
      data: {
        name, nameKey: normalizeName(name), type: s.type, unit: s.unit, inputFormat: s.inputFormat ?? LeverInputFormat.SINGLE,
        explanation: `Why ${s.name} matters to a buyer.`, relatedNeeds: ['testing'], allowedValues: s.allowedValues ?? [],
        safetyFlag: s.safetyFlag ?? false, origin: LeverOrigin.ADMIN,
      },
    })
    out.push(await prisma.nodeLever.create({ data: { nodeId, definitionId: def.id, origin: LeverOrigin.ADMIN }, include: { definition: true } }))
  }
  return out
}

export async function addProducts(nodeId: string, n: number, opts: { status?: CatalogStatus; dryRun?: boolean; brand?: string } = {}) {
  const slug = (await prisma.taxonomyNode.findUniqueOrThrow({ where: { id: nodeId }, select: { slug: true } })).slug
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(await prisma.product.create({
      data: {
        name: `Model ${i + 1} ${uid()}`, brand: opts.brand ?? 'Testbrand', category: slug, nodeId, catalogStatus: opts.status ?? CatalogStatus.APPROVED,
        approvedVia: (opts.status ?? CatalogStatus.APPROVED) === CatalogStatus.APPROVED ? 'AUTO' : null, isDryRun: !!opts.dryRun,
      },
    }))
  }
  return out
}

/** A value with evidence for a product and lever definition, in the given review state. */
export async function setValue(productId: string, definitionId: string, opts: {
  status?: ValueStatus; number?: number; text?: string; bool?: boolean; list?: string[]; unknown?: boolean; confidence?: Confidence
  origin?: ValueOrigin; acceptMode?: AcceptMode; userId?: string
} = {}) {
  const status = opts.status ?? ValueStatus.ACCEPTED
  const unknown = !!opts.unknown
  return prisma.productLeverValue.upsert({
    where: { productId_definitionId: { productId, definitionId } },
    create: {
      productId, definitionId, status, origin: opts.origin ?? ValueOrigin.EXTRACTED, isUnknown: unknown,
      valueNumber: unknown ? null : opts.number ?? null, valueText: unknown ? null : opts.text ?? null, valueBool: unknown ? null : opts.bool ?? null,
      valueList: unknown ? [] : opts.list ?? [], unit: unknown || opts.number === undefined ? null : 'lb',
      evidenceQuote: unknown ? null : 'Spec: value', sourceUrl: unknown ? null : 'https://brand.example/p',
      confidence: unknown ? null : opts.confidence ?? Confidence.HIGH,
      acceptMode: status === ValueStatus.ACCEPTED ? opts.acceptMode ?? AcceptMode.SINGLE : null,
      reviewedAt: status === ValueStatus.PROPOSED ? null : new Date(), reviewedById: status === ValueStatus.PROPOSED ? null : opts.userId ?? null,
    },
    update: {},
  })
}

/** Accept a known value of the right type for every product on every lever. */
export async function acceptAll(productIds: string[], levers: { definitionId: string; definition: { type: LeverType; allowedValues: string[] } }[], skip: (p: number, l: number) => boolean = () => false) {
  for (const [pi, p] of productIds.entries()) {
    for (const [li, l] of levers.entries()) {
      if (skip(pi, li)) continue
      const t = l.definition.type
      await setValue(p, l.definitionId, {
        number: t === LeverType.MEASUREMENT ? 10 + pi : undefined,
        text: t === LeverType.CATEGORY ? l.definition.allowedValues[0] : undefined,
        bool: t === LeverType.BOOLEAN ? pi % 2 === 0 : undefined,
        list: t === LeverType.COMPATIBILITY_LIST ? ['Carrier A'] : undefined,
      })
    }
  }
}

// ── Brand domains and hosts ─────────────────────────────────────────────────────────────────────────
export async function verifiedBrand(brand: string, host: string) {
  return prisma.brandDomain.upsert({
    where: { host },
    create: { brand, brandKey: brand.toLowerCase().replace(/[^a-z0-9]/g, ''), host, status: BrandDomainStatus.VERIFIED, verifiedVia: BrandVerifiedVia.ADMIN, verifiedAt: new Date() },
    update: { status: BrandDomainStatus.VERIFIED, verifiedVia: BrandVerifiedVia.ADMIN, verifiedAt: new Date() },
  })
}

export async function forgetHosts(hosts: string[]) {
  await prisma.brandDomain.deleteMany({ where: { host: { in: hosts } } })
  await prisma.fetchHost.deleteMany({ where: { host: { in: hosts } } })
}

// ── A fake web ──────────────────────────────────────────────────────────────────────────────────────
export type Route = { status?: number; type?: string; body?: string | Uint8Array; headers?: Record<string, string> }

export class FakeWeb {
  routes = new Map<string, Route | ((url: string) => Route)>()
  requests: { url: string; headers: Record<string, string> }[] = []
  sleeps: number[] = []
  clock = Date.now()

  set(url: string, route: Route | ((url: string) => Route)) { this.routes.set(url, route); return this }

  page(url: string, html: string) { return this.set(url, { body: html }) }

  transport: Transport = async (req) => {
    this.requests.push({ url: req.url, headers: req.headers })
    const r0 = this.routes.get(req.url)
    if (r0 === undefined) {
      if (req.url.endsWith('/robots.txt')) return response({ status: 404, type: 'text/plain', body: 'not found' })
      return response({ status: 404, body: 'not found' })
    }
    const r = typeof r0 === 'function' ? r0(req.url) : r0
    if (r.status === -1) throw new TypeError('fetch failed')
    return response(r)
  }

  fetcher(): Fetcher {
    return new Fetcher({
      transport: this.transport,
      now: () => this.clock,
      sleep: async (ms) => { this.sleeps.push(ms); this.clock += ms },
      retryDelayMs: 30_000,
    })
  }

  install(): Fetcher {
    const f = this.fetcher()
    setFetcherForTests(f)
    return f
  }

  urls() { return this.requests.map((r) => r.url) }
}

function response(r: Route): TransportResponse {
  const headers: Record<string, string> = { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.headers ?? {}) }
  const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body ?? new Uint8Array()
  return { status: r.status ?? 200, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, body, truncated: false }
}

export function homePage(siteName: string, opts: { ld?: boolean } = {}) {
  const ld = opts.ld === false ? '' : `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: siteName })}</script>`
  return `<html><head><title>${siteName}</title><meta property="og:site_name" content="${siteName}">${ld}</head><body><h1>${siteName}</h1></body></html>`
}

export function productPage(name: string, specs: string[], opts: { links?: { href: string; text: string }[]; title?: string } = {}) {
  const links = (opts.links ?? []).map((l) => `<a href="${l.href}">${l.text}</a>`).join('')
  return `<html><head><title>${opts.title ?? name}</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: opts.title ?? name })}</script></head>`
    + `<body><nav>Menu Shop Sale 99 lb</nav><h1>${opts.title ?? name}</h1><ul>${specs.map((s) => `<li>${s}</li>`).join('')}</ul>${links}<footer>© 2026</footer></body></html>`
}

/** An error as the SDK builds it from a real API answer. */
export function apiError(status: number, type: string, message: string, requestId = 'req_011CPROBE') {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type, message }, request_id: requestId }, undefined, new Headers({ 'request-id': requestId }))
}

// ── A stub model ────────────────────────────────────────────────────────────────────────────────────
type Stage = 'place' | 'levers' | 'discover' | 'extract' | 'explain'
export type StubAnswer = Partial<ModelResult> | ((input: never) => Partial<ModelResult>)

export class StubModel implements GenerationModel {
  calls: Record<Stage, number> = { place: 0, levers: 0, discover: 0, extract: 0, explain: 0 }
  inputs: Partial<Record<Stage, unknown[]>> = {}
  constructor(public answers: Partial<Record<Stage, StubAnswer>>) {}

  private async answer(stage: Stage, input: unknown): Promise<ModelResult> {
    this.calls[stage]++
    ;(this.inputs[stage] ??= []).push(input)
    const a = this.answers[stage]
    if (!a) throw new Error(`no stub answer for ${stage}`)
    const r = typeof a === 'function' ? (a as (i: unknown) => Partial<ModelResult>)(input) : a
    return {
      output: r.output ?? null, stopReason: r.stopReason ?? 'end_turn', servedModel: r.servedModel ?? 'claude-opus-5-5',
      usage: r.usage ?? { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, webSearches: 0 },
    }
  }

  place(i: unknown) { return this.answer('place', i) }
  levers(i: unknown) { return this.answer('levers', i) }
  discover(i: unknown) { return this.answer('discover', i) }
  extract(i: unknown) { return this.answer('extract', i) }
  explain(i: unknown) { return this.answer('explain', i) }

  install() { setGenerationModelForTests(this); return this }
}

export const PLACEMENT = { primaryParentFits: true, suggestedPrimaryParent: null, secondaryParents: [], searchTerms: ['widget'], rationale: 'Fits.' }

export interface StubCandidate { reuseDefinitionId: string | null; definition: unknown; note: string | null }

export function leverSet(n = 10): { candidates: StubCandidate[]; referenceNotes: unknown[] } {
  return {
    candidates: Array.from({ length: n }, (_, i) => ({
      reuseDefinitionId: null,
      definition: {
        name: `Lever ${uid()} ${i}`, type: i === 0 ? 'MEASUREMENT' : 'BOOLEAN', inputFormat: 'SINGLE', unit: i === 0 ? 'lb' : null,
        explanation: `Lever ${i} decides fit for some buyers.`, relatedNeeds: ['testing'], allowedValues: [], safetyFlag: false,
      },
      note: null,
    })),
    referenceNotes: [],
  }
}

const GEN_ENV = ['GENERATION_MODE', 'LEVER_GEN_MODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'GENERATION_RUN_CAP_USD', 'GENERATION_DAILY_CAP_USD', 'GENERATION_MIN_PRODUCTS', 'GENERATION_MAX_TOKENS'] as const

export function liveMode(extra: Partial<Record<(typeof GEN_ENV)[number], string>> = {}) {
  process.env.GENERATION_MODE = 'live'
  process.env.ANTHROPIC_API_KEY = 'test-key-never-sent'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

export function resetGenerationEnv() {
  for (const k of GEN_ENV) delete process.env[k]
  process.env.GENERATION_MODE = 'dry_run'
  process.env.ANTHROPIC_API_KEY = ''
  setGenerationModelForTests(null)
  setFetcherForTests(null)
}
