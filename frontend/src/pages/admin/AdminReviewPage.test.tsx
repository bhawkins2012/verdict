import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminReviewPage } from './AdminReviewPage'
import { api, routes } from '../../test/apiMock'
import { click, render, Rendered, settle } from '../../test/render'
import { BoardLever, ReviewData, ReviewProduct, ReviewValue } from '../../types/levers'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

const lever = (i: number, extra: Partial<BoardLever> = {}): BoardLever => ({
  id: `l${i}`, definitionId: `d${i}`, name: `Lever ${i}`, type: 'MEASUREMENT', inputFormat: 'SINGLE', unit: 'lb', explanation: `Why lever ${i} matters.`,
  relatedNeeds: [], allowedValues: [], status: 'CANDIDATE', position: null, origin: 'GENERATED', note: null, safety: false, approvedBy: null,
  approvedAt: null, sharedWith: [], coverage: { found: 3, accepted: 0, products: 3 }, survey: null, ...extra,
})
const product = (i: number, extra: Partial<ReviewProduct> = {}): ReviewProduct => ({
  id: `p${i}`, name: `Model ${i}`, brand: 'Acme', url: `https://acme.example/${i}`, status: 'APPROVED', approvedVia: 'AUTO', attentionCheck: null,
  attentionReason: null, listed: false, isDryRun: true, reviewedBy: null, item: null, ...extra,
})
const value = (p: number, l: number, extra: Partial<ReviewValue> = {}): ReviewValue => ({
  id: `v${p}-${l}`, productId: `p${p}`, definitionId: `d${l}`, status: 'PROPOSED', origin: 'EXTRACTED',
  value: { unknown: false, number: 9 + p, unit: 'lb', text: null, bool: null, list: [], dimensions: null, detail: null },
  statedValue: String(9 + p), statedUnit: 'lb', quote: `Lever ${l}: ${9 + p} lb`, sourceUrl: `https://acme.example/${p}`, confidence: 'HIGH',
  unknownReason: null, adminAttested: false, attestedFetchOutcome: null, edited: false, originalValue: null, acceptMode: null, reviewedBy: null,
  reviewedAt: null, editedBy: null, ...extra,
})

let data: ReviewData
function review(): ReviewData {
  const levers = [0, 1, 2, 3, 4, 5].map((i) => lever(i, i < 5 ? { status: 'APPROVED', position: i + 1, safety: i === 0 } : {}))
  levers[0].coverage = { found: 3, accepted: 2, products: 3 }
  levers[5].coverage = { found: 1, accepted: 0, products: 3 }
  const products = [product(0), product(1), product(2), product(3, { status: 'NEEDS_ATTENTION', approvedVia: null, attentionCheck: 'modelNamed', attentionReason: '"Model 3" is not in the page title' })]
  const values = products.slice(0, 3).flatMap((p, pi) => [0, 1, 2, 3, 4].map((l) => value(pi, l)))
  return {
    node: { id: 'n1', slug: 'things', name: 'Things', publishedAt: null, safetyCritical: false, path: ['Root', 'Things'] },
    config: { minProducts: 3, mode: 'dry_run' }, run: null, products, levers, values,
    progress: { products: { PROPOSED: 0, APPROVED: 3, NEEDS_ATTENTION: 1, REJECTED: 0 }, values: { reviewed: 0, total: 15 } },
  }
}

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  api.get.mockClear()
  api.post.mockClear()
  data = review()
  routes.set('GET /admin/nodes/n1/review', () => data)
})
afterEach(() => view?.unmount())

async function open(step: 'Products' | 'Levers' | 'Values') {
  view = render(<AdminReviewPage />, { route: '/admin/nodes/:id/review', path: '/admin/nodes/n1/review' })
  await settle()
  await click([...view.container.querySelectorAll('nav[aria-label="Review steps"] button')].find((b) => b.textContent?.includes(step)) ?? null)
  await settle(2)
}

const key = async (el: Element | null, k: string) => {
  await act(async () => { el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
  await settle(2)
}

describe('products step', () => {
  it('lists the exceptions with the failed check, and approves one with the keyboard', async () => {
    routes.set('POST /admin/products/approve', () => ({ approved: 1 }))
    await open('Products')
    const row = view?.container.querySelector('[data-testid="product-Model 3"]')
    expect(row?.textContent).toContain('Model named on page:')
    expect(row?.textContent).toContain('"Model 3" is not in the page title')
    expect(view?.container.querySelectorAll('tbody tr[data-testid]')).toHaveLength(1) // needs attention only
    await key(row ?? null, 'a')
    expect(api.post).toHaveBeenCalledWith('/admin/products/approve', { productIds: ['p3'] })
  })
})

describe('levers step', () => {
  it('shows each card\'s data coverage, amber below 80%', async () => {
    await open('Levers')
    const card = view?.container.querySelector('[data-testid="lever-Lever 5"]')
    const badge = card?.querySelector('[data-testid="coverage"]')
    expect(badge?.textContent).toBe('1 of 3')
    expect(badge?.className).toContain('amber')
    const full = view?.container.querySelector('[data-testid="lever-Lever 0"] [data-testid="coverage"]')
    expect(full?.textContent).toBe('3 of 3 (2 accepted)')
    expect(full?.className).not.toContain('amber')
    expect(view?.container.querySelector('[data-testid="lever-Lever 0"]')?.textContent).toContain('Safety')
  })
})

describe('values step', () => {
  it('Enter accepts the focused value and moves to the next unreviewed one; the evidence shows beside it', async () => {
    routes.set('POST /admin/values/v0-0/accept', () => ({ id: 'v0-0', status: 'ACCEPTED' }))
    await open('Values')
    const grid = view?.container.querySelector('[role="grid"]')
    const first = grid?.querySelector('[data-cell="0-0"]')
    expect(document.activeElement).toBe(first)
    expect(view?.container.querySelector('[data-testid="evidence-quote"]')?.textContent).toBe('“Lever 0: 9 lb”')
    await key(first ?? null, 'Enter')
    expect(api.post.mock.calls.map((c) => c[0])).toEqual(['/admin/values/v0-0/accept'])
    expect(document.activeElement?.getAttribute('data-cell')).toBe('0-1')
  })

  it('arrow keys move between values; R rejects, U marks unknown', async () => {
    routes.set('POST /admin/values/v1-1/reject', () => ({}))
    routes.set('POST /admin/values/v1-1/unknown', () => ({}))
    await open('Values')
    const grid = view?.container.querySelector('[role="grid"]')
    await key(grid?.querySelector('[data-cell="0-0"]') ?? null, 'ArrowDown')
    await key(document.activeElement, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-cell')).toBe('1-1')
    await key(document.activeElement, 'r')
    await key(document.activeElement, 'u')
    expect(api.post.mock.calls.map((c) => c[0])).toEqual(['/admin/values/v1-1/reject', '/admin/values/v1-1/unknown'])
  })

  it('a safety lever\'s column has no bulk accept; other columns do', async () => {
    routes.set('POST /admin/nodes/n1/values/bulk-accept', () => ({ accepted: 3 }))
    await open('Values')
    const headers = [...(view?.container.querySelectorAll('[role="columnheader"]') ?? [])]
    const safety = headers.find((h) => h.textContent?.startsWith('Lever 0'))
    expect(safety?.querySelector('button')).toBeNull()
    expect(safety?.textContent).toContain('one by one (safety)')
    const other = headers.find((h) => h.textContent?.startsWith('Lever 1'))
    await click(other?.querySelector('button') ?? null)
    await settle(2)
    expect(api.post).toHaveBeenCalledWith('/admin/nodes/n1/values/bulk-accept', { definitionId: 'd1' })
  })

  it('the unknown filter shows only unknown values', async () => {
    data.values[5] = value(1, 0, { value: { ...data.values[5].value, unknown: true, number: null }, unknownReason: 'quote_not_found', quote: null })
    await open('Values')
    await click([...(view?.container.querySelectorAll('[aria-label="Filter values"] button') ?? [])].find((b) => b.textContent === 'Unknown') ?? null)
    await settle(2)
    const rows = [...(view?.container.querySelectorAll('[role="rowheader"]') ?? [])].map((r) => r.textContent)
    expect(rows).toEqual(['Acme Model 1'])
  })
})
