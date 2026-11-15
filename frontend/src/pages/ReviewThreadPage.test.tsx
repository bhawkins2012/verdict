import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewThreadPage } from './ReviewThreadPage'
import { routes } from '../test/apiMock'
import { render, Rendered, settle } from '../test/render'

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

const thread = (nextCheckIn: { stage: string; dueAt: string } | null) => ({
  id: 't1', userId: 'u1', productId: 'p1', startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  stagesCompleted: ['INITIAL'],
  product: { id: 'p1', name: 'Kettle', brand: 'Acme', category: 'kitchen' },
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
})
