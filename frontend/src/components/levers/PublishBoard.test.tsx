import { act, useState } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PublishBoard } from './PublishBoard'
import { render, Rendered, settle } from '../../test/render'
import { AdminLever } from '../../types/levers'

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const lever = (id: string, name: string, status: AdminLever['status'] = 'CANDIDATE', position: number | null = null): AdminLever => ({
  id, name, type: 'BOOLEAN', inputFormat: 'SINGLE', unit: null, explanation: `Why ${name} matters.`, relatedNeeds: [],
  allowedValues: [], status, position, origin: 'GENERATED', runId: null, approvedBy: null, approvedAt: null, editedBy: null,
  editedAt: null, valueCount: 0, survey: null,
})
const LEVERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => lever(n.toLowerCase(), `Lever ${n}`))

function Harness({ initial, onPublish }: { initial: string[]; onPublish: (ids: string[]) => void }) {
  const [set, setSet] = useState(initial)
  return <PublishBoard levers={LEVERS} set={set} onSetChange={setSet} onPublish={onPublish} renderControls={() => null} />
}

// ── Layout for dnd-kit under jsdom ───────────────────────────────────────────────────────────────────
// jsdom has no layout, and the keyboard sensor moves between measured rectangles. Give each zone a column
// (set on the right, candidates on the left) and each card a 60 px row in its zone, like the real page.
const ZONE_X = { candidates: 0, set: 400 } as const
function fakeRect(el: Element): DOMRect {
  const r = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect
  // The drag overlay starts exactly over the card being dragged (dnd-kit then translates it).
  const overlay = el.closest('[data-dnd-overlay]')
  if (overlay) {
    const card = document.querySelector(`[data-dnd-id="${overlay.getAttribute('data-dnd-overlay')}"]`)
    return card ? fakeRect(card) : r(0, 0, 0, 0)
  }
  const zoneEl = el.closest('[data-dnd-zone]')
  const zone = (zoneEl?.getAttribute('data-dnd-zone') ?? 'candidates') as keyof typeof ZONE_X
  if (el.hasAttribute('data-dnd-zone')) return r(ZONE_X[zone], 0, 300, 600)
  const card = el.closest('[data-dnd-id]')
  if (card && zoneEl) {
    const cards = [...zoneEl.querySelectorAll('[data-dnd-id]')]
    return r(ZONE_X[zone] + 10, 40 + cards.indexOf(card) * 60, 280, 50)
  }
  return r(0, 0, 0, 0)
}
let original: typeof Element.prototype.getBoundingClientRect
beforeAll(() => {
  original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () { return fakeRect(this) }
  Element.prototype.scrollIntoView = () => undefined
})
afterAll(() => { Element.prototype.getBoundingClientRect = original })

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────
let view: Rendered | undefined
afterEach(() => view?.unmount())

const q = <T extends Element>(sel: string) => {
  const el = view?.container.querySelector<T>(sel)
  if (!el) throw new Error(`not found: ${sel}`)
  return el
}
const slotNames = () => [...q('ol[aria-label="Publish set slots"]').querySelectorAll('[data-dnd-id]')].map((el) => el.querySelector('.font-medium')?.textContent)
const candidateNames = () => [...q('ul[aria-label="Candidate levers"]').querySelectorAll('[data-dnd-id]')].map((el) => el.querySelector('.font-medium')?.textContent)
const publishButton = () => [...view!.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve and publish'))!

/** Press a key on the focused element (dnd-kit reads event.code). */
async function press(code: string, key = code === 'Space' ? ' ' : code) {
  await act(async () => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
}
const liveText = () => [...document.querySelectorAll('[aria-live]')].map((el) => el.textContent).join(' | ')

describe('publish board: keyboard drag (no mouse)', () => {
  it('reorders the set: pick up slot 1 with Space, two Arrow Downs, drop with Space', async () => {
    const onPublish = vi.fn()
    view = render(<Harness initial={['a', 'b', 'c', 'd', 'e']} onPublish={onPublish} />)
    await settle()
    q<HTMLButtonElement>('[data-testid="handle-Lever A"]').focus()
    await press('Space')
    expect(liveText()).toMatch(/Picked up Lever A, in position 1 of 5 in the publish set/)
    await press('ArrowDown')
    await press('ArrowDown')
    await press('Space')
    await settle()
    expect(slotNames()).toEqual(['Lever B', 'Lever C', 'Lever A', 'Lever D', 'Lever E'])
    expect(liveText()).toMatch(/Lever A moved to position 3 of 5/)
    await act(async () => publishButton().click())
    expect(onPublish).toHaveBeenCalledWith(['b', 'c', 'a', 'd', 'e'])
  })

  it('Escape cancels a keyboard drag and leaves the order unchanged', async () => {
    view = render(<Harness initial={['a', 'b', 'c']} onPublish={vi.fn()} />)
    await settle()
    q<HTMLButtonElement>('[data-testid="handle-Lever B"]').focus()
    await press('Space')
    await press('ArrowDown')
    await press('Escape')
    await settle()
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever C'])
    expect(liveText()).toMatch(/Moving Lever B was cancelled/)
  })
})

describe('publish board: Actions menu (non-drag fallback, keyboard only)', () => {
  async function openMenuFor(name: string) {
    q<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`).focus()
    await act(async () => q<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`).click())
    await settle(1)
  }
  async function choose(label: string) {
    const item = [...view!.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith(label))
    if (!item) throw new Error(`no menu item ${label}`)
    await act(async () => item.click())
    await settle(1)
  }

  it('adds candidates, moves within the set, removes, and publishes in slot order', async () => {
    const onPublish = vi.fn()
    view = render(<Harness initial={[]} onPublish={onPublish} />)
    await settle()
    expect(publishButton().disabled).toBe(true)
    for (const n of ['A', 'B', 'C', 'D', 'E']) {
      await openMenuFor(`Lever ${n}`)
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem') // focus moves into the menu
      await choose('Add to set')
    }
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever C', 'Lever D', 'Lever E'])
    expect(publishButton().disabled).toBe(false)

    await openMenuFor('Lever E')
    await choose('Move up')
    await openMenuFor('Lever E')
    await choose('Move up')
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever E', 'Lever C', 'Lever D'])
    expect(liveText()).toMatch(/Lever E moved to position 3 of 5/)

    await openMenuFor('Lever B')
    await choose('Remove from set')
    expect(slotNames()).toEqual(['Lever A', 'Lever E', 'Lever C', 'Lever D'])
    expect(candidateNames()).toEqual(['Lever B', 'Lever F', 'Lever G'])
    expect(publishButton().disabled).toBe(true)

    await openMenuFor('Lever G')
    await choose('Add to set')
    await act(async () => publishButton().click())
    expect(onPublish).toHaveBeenCalledWith(['a', 'e', 'c', 'd', 'g'])
  })

  it('a sixth lever cannot be added: the menu item is disabled with the reason', async () => {
    view = render(<Harness initial={['a', 'b', 'c', 'd', 'e']} onPublish={vi.fn()} />)
    await settle()
    await openMenuFor('Lever F')
    const add = [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith('Add to set'))
    expect(add?.getAttribute('aria-disabled')).toBe('true')
    expect(add?.textContent).toMatch(/already has five; remove one first/)
    await act(async () => add?.click())
    expect(slotNames()).toHaveLength(5)
    expect(candidateNames()).toContain('Lever F')
  })

  it('Escape closes the menu and returns focus to its button; arrow keys move between items', async () => {
    view = render(<Harness initial={['a', 'b', 'c']} onPublish={vi.fn()} />)
    await settle()
    await openMenuFor('Lever B')
    const first = document.activeElement
    expect(first?.textContent).toMatch(/^Move up/)
    await press('ArrowDown', 'ArrowDown')
    expect(document.activeElement?.textContent).toMatch(/^Move down/)
    await press('Escape', 'Escape')
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for Lever B')
  })
})

describe('publish board: keyboard drag of a sixth candidate', () => {
  it('is refused, with the reason shown and announced; the set is unchanged', async () => {
    view = render(<Harness initial={['a', 'b', 'c', 'd', 'e']} onPublish={vi.fn()} />)
    await settle()
    q<HTMLButtonElement>('[data-testid="handle-Lever F"]').focus()
    await press('Space')
    await press('ArrowRight') // towards the publish set column
    await press('Space')
    await settle()
    expect(slotNames()).toEqual(['Lever A', 'Lever B', 'Lever C', 'Lever D', 'Lever E'])
    expect(q('[data-testid="full-notice"]').textContent).toMatch(/already has five levers/)
    expect(liveText()).toMatch(/already has five levers/)
  })
})
