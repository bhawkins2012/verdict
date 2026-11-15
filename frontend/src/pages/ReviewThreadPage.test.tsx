import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewThreadPage } from './ReviewThreadPage'
import { routes } from '../test/apiMock'
import { click, render, Rendered, settle } from '../test/render'

vi.mock('../lib/api', () => import('../test/apiMock'))

const CONFIG = {
  stages: ['INITIAL', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS', 'CUSTOM'].map((stage) => ({ stage, label: stage })),
  nudgeCadence: [
    { stage: 'TWO_WEEKS', label: '2 weeks', offset: { days: 14 } },
    { stage: 'THREE_MONTHS', label: '3 months', offset: { months: 3 } },
    { stage: 'ONE_YEAR', label: '1 year', offset: { months: 12 } },
    { stage: 'TWO_YEARS', label: '2 years', offset: { months: 24 } },
  ],
  consentCopy: 'Email me check-ins at 2 weeks, 3 months, 1 year, and 2 years.',
}

const thread = (nextCheckIn: { stage: string; dueAt: string } | null, productId = 'p1') => ({
  id: 't-' + productId, userId: 'u1', productId, startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  stagesCompleted: ['INITIAL'],
  product: { id: productId, name: 'Kettle', brand: 'Acme', category: 'kitchen' },
  reviews: [{ id: 'r1', stage: 'INITIAL', scoreOverall: 8, capturedAt: '2026-11-01T00:00:00Z', pros: [], cons: [] }],
  nextCheckIn,
})

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  routes.set('GET /reviews/product/p1/stats', () => ({ survivorshipCurve: [] }))
  routes.set('GET /users/me/notification-settings', () => ({ emailNudgesEnabled: false, timezone: 'UTC' }))
})
afterEach(() => view?.unmount())

const reviewLinks = (v: Rendered) =>
  [...v.container.querySelectorAll<HTMLAnchorElement>('a')].map((a) => a.getAttribute('href') ?? '').filter((h) => h.includes('/review?'))

describe('review thread page', () => {
  it("the next-review button is the backend planner's next check-in (2 weeks after a first impression), never ONE_WEEK", async () => {
    routes.set('GET /config', () => CONFIG)
    routes.set('GET /reviews/thread/p1', () => thread({ stage: 'TWO_WEEKS', dueAt: '2026-11-15T00:00:00Z' }))
    view = render(<ReviewThreadPage />, { route: '/products/:id', path: '/products/p1' })
    await settle()
    expect(reviewLinks(view)).toEqual(['/products/p1/review?stage=TWO_WEEKS'])
    expect(view.container.textContent).not.toMatch(/1 Week/i)
  })

  it('follows the planner when it skips ahead (e.g. 2 weeks skipped or overdue): 3 months', async () => {
    routes.set('GET /config', () => CONFIG)
    routes.set('GET /reviews/thread/p1', () => thread({ stage: 'THREE_MONTHS', dueAt: '2027-02-01T00:00:00Z' }))
    view = render(<ReviewThreadPage />, { route: '/products/:id', path: '/products/p1' })
    await settle()
    expect(reviewLinks(view)).toEqual(['/products/p1/review?stage=THREE_MONTHS'])
  })

  it('still renders the thread when /api/config fails', async () => {
    routes.set('GET /config', () => new Error('503'))
    routes.set('GET /reviews/thread/p1', () => thread({ stage: 'TWO_WEEKS', dueAt: '2026-11-15T00:00:00Z' }))
    view = render(<ReviewThreadPage />, { route: '/products/:id', path: '/products/p1' })
    await settle()
    expect(view.container.textContent).toContain('Kettle')
    expect(reviewLinks(view)).toEqual(['/products/p1/review?stage=TWO_WEEKS'])
  })

  it('shows the opt-in prompt right after the first review only', async () => {
    routes.set('GET /config', () => CONFIG)
    routes.set('GET /reviews/thread/p1', () => thread(null))
    view = render(<ReviewThreadPage />, { route: '/products/:id', path: '/products/p1', state: { firstReview: true } })
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')?.textContent).toContain(CONFIG.consentCopy)
    view.unmount()

    view = render(<ReviewThreadPage />, { route: '/products/:id', path: '/products/p1' })
    await settle()
    expect(view.container.querySelector('[data-testid="checkin-opt-in"]')).toBeNull()
  })

  describe('opt-in prompt across products (until the user opts in or declines)', () => {
    // Server-side settings shared by every render, like the real API.
    let settings: { emailNudgesEnabled: boolean; timezone: string; nudgePromptDismissedAt: string | null }
    const firstReviewOf = async (productId: string) => {
      view?.unmount()
      view = render(<ReviewThreadPage />, { route: '/products/:id', path: `/products/${productId}`, state: { firstReview: true } })
      await settle()
      return view.container.querySelector('[data-testid="checkin-opt-in"]')
    }
    beforeEach(() => {
      settings = { emailNudgesEnabled: false, timezone: 'UTC', nudgePromptDismissedAt: null }
      routes.set('GET /config', () => CONFIG)
      for (const p of ['p1', 'p2']) {
        routes.set(`GET /reviews/thread/${p}`, () => thread(null, p))
        routes.set(`GET /reviews/product/${p}/stats`, () => ({ survivorshipCurve: [] }))
      }
      routes.set('GET /users/me/notification-settings', () => settings)
      routes.set('PUT /users/me/notification-settings', (body) => (settings = { ...settings, ...(body as object) }))
      routes.set('POST /users/me/nudge-prompt/dismiss', () => (settings = { ...settings, nudgePromptDismissedAt: '2026-11-15T00:00:00.000Z' }))
    })

    it('ignored (neither opted in nor declined): shown again after the first review of the next product', async () => {
      expect(await firstReviewOf('p1')).not.toBeNull()
      expect(await firstReviewOf('p2')).not.toBeNull()
    })

    it('declined: never shown again', async () => {
      const prompt = await firstReviewOf('p1')
      await click([...(prompt?.querySelectorAll('button') ?? [])].find((b) => /No thanks/.test(b.textContent ?? '')) ?? null)
      await settle()
      expect(settings.nudgePromptDismissedAt).not.toBeNull()
      expect(await firstReviewOf('p2')).toBeNull()
    })

    it('opted in: not shown again', async () => {
      const prompt = await firstReviewOf('p1')
      await click(prompt?.querySelector('input[type="checkbox"]') ?? null)
      await settle()
      expect(settings.emailNudgesEnabled).toBe(true)
      expect(await firstReviewOf('p2')).toBeNull()
    })
  })
})
