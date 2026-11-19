import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminCategoryPage } from './AdminCategoryPage'
import { api, routes } from '../../test/apiMock'
import { click, render, Rendered, settle } from '../../test/render'
import { AdminCategoryDetail, AdminLever } from '../../types/levers'

vi.mock('../../lib/api', () => import('../../test/apiMock'))

const lever = (id: string, name: string, status: AdminLever['status'] = 'CANDIDATE', position: number | null = null): AdminLever => ({
  id, name, type: 'BOOLEAN', inputFormat: 'SINGLE', unit: null, explanation: `Why ${name} matters.`, relatedNeeds: [],
  allowedValues: [], status, position, origin: 'GENERATED', runId: null, approvedBy: null, approvedAt: status === 'APPROVED' ? '2026-11-19T00:00:00Z' : null,
  editedBy: null, editedAt: null, valueCount: 0, survey: null,
})
const NAMES = ['A', 'B', 'C', 'D', 'E', 'F']
const detail = (levers: AdminLever[], published = false): AdminCategoryDetail => ({
  id: 'c1', slug: 'things', name: 'Things', searchTerms: [], leversPublishedAt: published ? '2026-11-19T00:00:00Z' : null,
  leversPublishedBy: published ? 'admin' : null, levers, runs: [], survey: null, products: [],
})
const candidates = () => NAMES.map((n) => lever(n.toLowerCase(), `Lever ${n}`))

let view: Rendered | undefined
let current: AdminCategoryDetail
beforeEach(() => {
  routes.clear()
  api.get.mockClear()
  api.post.mockClear()
  current = detail(candidates())
  routes.set('GET /admin/categories/c1', () => current)
  routes.set('GET /admin/config', () => ({ mode: 'dry_run', model: 'dry-run', dailyLimit: 10, maxTokens: 16000 }))
})
afterEach(() => view?.unmount())

const slotNames = () => [...(view?.container.querySelector('ol[aria-label="Publish set slots"]')?.querySelectorAll('[data-dnd-id]') ?? [])]
  .map((el) => el.querySelector('.font-medium')?.textContent)
const buttonByText = (text: RegExp) => [...(view?.container.querySelectorAll('button') ?? [])].find((b) => text.test(b.textContent ?? '')) ?? null

async function addViaMenu(name: string) {
  await click(view?.container.querySelector(`button[aria-label="Actions for ${name}"]`) ?? null)
  await settle(1)
  await click([...(view?.container.querySelectorAll('[role="menuitem"]') ?? [])].find((b) => b.textContent?.startsWith('Add to set')) ?? null)
  await settle(1)
}

async function renderPage() {
  view = render(<AdminCategoryPage />, { route: '/admin/categories/:id', path: '/admin/categories/c1' })
  await settle()
}

describe('admin category page: publish', () => {
  it('after publishing, the five stay in the set while the page refetches (no flash back to Candidates)', async () => {
    await renderPage()
    for (const n of ['A', 'B', 'C', 'D', 'E']) await addViaMenu(`Lever ${n}`)
    expect(slotNames()).toHaveLength(5)

    // The publish succeeds, but the refetch is held open: the data still has no approved levers.
    let releaseRefetch: () => void = () => undefined
    routes.set('POST /admin/categories/c1/publish', () => ({ levers: [] }))
    routes.set('GET /admin/categories/c1', () => new Promise((resolve) => {
      releaseRefetch = () => resolve(detail(candidates().map((l, i) => (i < 5 ? { ...l, status: 'APPROVED' as const, position: i + 1 } : l)), true))
    }))
    await click(buttonByText(/Approve and publish these five/))
    await settle()
    expect(api.post).toHaveBeenCalledWith('/admin/categories/c1/publish', { leverIds: ['a', 'b', 'c', 'd', 'e'] })
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever C', 'Lever D', 'Lever E'])

    await act(async () => releaseRefetch())
    await settle()
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever C', 'Lever D', 'Lever E'])
    expect(view?.container.textContent).toContain('Published.')
  })
})

describe('admin category page: retiring a lever that is in the unsaved set', () => {
  it('frees its slot (no ghost slot that counts towards five)', async () => {
    await renderPage()
    for (const n of ['A', 'B', 'C']) await addViaMenu(`Lever ${n}`)
    routes.set('POST /admin/levers/b/retire', () => ({ id: 'b', status: 'RETIRED' }))
    current = detail(candidates().map((l) => (l.id === 'b' ? { ...l, status: 'RETIRED' as const } : l)))
    const card = view?.container.querySelector('[data-testid="lever-Lever B"]')
    await click([...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith('Retire')) ?? null)
    await settle()
    expect(slotNames()).toEqual(['Lever A', 'Lever C'])
    expect(view?.container.textContent).toContain('Publish set (2 / 5)')
    expect(buttonByText(/Approve and publish these five/)?.disabled).toBe(true)
  })
})

describe('admin category page: editing a card', () => {
  it('locks it in place while its form is open, so a move cannot drop what was typed', async () => {
    await renderPage()
    const card = () => view?.container.querySelector('[data-testid="lever-Lever A"]')
    await click([...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith('Edit')) ?? null)
    await settle(1)
    expect(card()?.querySelector('form')).not.toBeNull()
    await click(view?.container.querySelector('button[aria-label="Actions for Lever A"]') ?? null)
    await settle(1)
    const add = [...(view?.container.querySelectorAll('[role="menuitem"]') ?? [])].find((b) => b.textContent?.startsWith('Add to set'))
    expect(add?.getAttribute('aria-disabled')).toBe('true')
    expect(add?.textContent).toMatch(/close its edit form first/)
    // A press elsewhere closes the menu; closing the form unlocks the card.
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    await settle(1)
    expect(view?.container.querySelector('[role="menu"]')).toBeNull()
    await click([...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith('Close')) ?? null)
    await settle(1)
    await addViaMenu('Lever A')
    expect(slotNames()).toEqual(['Lever A'])
  })
})
