import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminNodesPage } from './AdminNodesPage'
import { routes } from '../../test/apiMock'
import { render, Rendered, settle } from '../../test/render'
import { AdminTreeNode } from '../../types/levers'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

const node = (id: string, kind: AdminTreeNode['kind'], launchOrder: number | null, children: AdminTreeNode['children'] = [], viaSecondary = false): AdminTreeNode & { viaSecondary: boolean } => ({
  id, slug: id, name: id, kind, depth: 0, publishedAt: null, visible: false, explainerApproved: false, safetyCritical: false, launchOrder,
  latestRun: null, products: { approved: 0, needsAttention: 0 }, levers: { candidates: 0, approved: 0 }, children, viaSecondary,
})

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  // Car seats is under Baby and kids, and also listed in Seats: the API returns its subtree twice.
  const carSeats = (via: boolean) => node('car-seats', 'NAVIGATION', null, [node('infant-car-seats', 'DECISION', 1), node('booster-seats', 'DECISION', 3)], via)
  routes.set('GET /admin/nodes', () => [
    node('baby', 'NAVIGATION', null, [carSeats(false), node('travel-strollers', 'DECISION', 2), node('seats', 'NAVIGATION', null, [carSeats(true)])]),
  ])
  routes.set('GET /admin/config', () => ({ mode: 'dry_run', model: 'dry-run', runCapUsd: 10, dailyCapUsd: 40, minProducts: 10, maxTokens: 16000, leversPerNode: 5 }))
  routes.set('GET /admin/summary', () => ({ readyForReview: 0, brandsToConfirm: 0, unplacedProducts: 0 }))
})
afterEach(() => view?.unmount())

describe('launch order', () => {
  it('lists each decision node once, in launch order, even when its parent is also listed elsewhere', async () => {
    view = render(<AdminNodesPage />)
    await settle(3)
    const items = [...(view.container.querySelectorAll('section[aria-label="Launch order"] li') ?? [])].map((li) => li.querySelector('a')?.textContent)
    expect(items).toEqual(['infant-car-seats', 'travel-strollers', 'booster-seats'])
  })
})
