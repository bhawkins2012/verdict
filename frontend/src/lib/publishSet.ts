// The admin publish set (docs/adr-levers.md D4): an ordered list of at most five lever ids. Pure functions,
// shared by drag and drop, the per-card menu and the screen-reader announcements, so all three agree.
// The server still enforces exactly five on publish (route check and database trigger).

export const SET_SIZE = 5

export const FULL_MESSAGE = 'The publish set already has five levers. Remove one first.'

export type Zone = 'candidates' | 'set'

export interface LeverLike {
  id: string
  status: 'CANDIDATE' | 'APPROVED' | 'RETIRED'
  position: number | null
}

/** The published levers in order: what the set starts as. */
export function initialSet(levers: readonly LeverLike[]): string[] {
  return levers
    .filter((l) => l.status === 'APPROVED')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((l) => l.id)
}

/**
 * Keep only ids of levers that are still live (not retired, still present). A lever retired or removed
 * while it sat in an unsaved set would otherwise leave a slot that counts towards five but shows nothing.
 */
export function pruneSet(set: readonly string[], levers: readonly LeverLike[]): string[] {
  const live = new Set(levers.filter((l) => l.status !== 'RETIRED').map((l) => l.id))
  return set.filter((id) => live.has(id))
}

/** Non-retired levers that are not in the set, in their original order. */
export function candidatesOf<T extends LeverLike>(levers: readonly T[], set: readonly string[]): T[] {
  return levers.filter((l) => l.status !== 'RETIRED' && !set.includes(l.id))
}

export type AddResult = { ok: true; set: string[] } | { ok: false; set: string[]; reason: 'full' | 'already-in-set' }

/** Insert at `index` (default: the end). Refuses a sixth lever and duplicates; the set is never changed then. */
export function addToSet(set: readonly string[], id: string, index: number = set.length): AddResult {
  if (set.includes(id)) return { ok: false, set: [...set], reason: 'already-in-set' }
  if (set.length >= SET_SIZE) return { ok: false, set: [...set], reason: 'full' }
  const at = Math.max(0, Math.min(index, set.length))
  return { ok: true, set: [...set.slice(0, at), id, ...set.slice(at)] }
}

export function removeFromSet(set: readonly string[], id: string): string[] {
  return set.filter((x) => x !== id)
}

/** Move the item at `from` to `to` (indexes clamped); other items keep their relative order. */
export function moveWithin(set: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= set.length) return [...set]
  const target = Math.max(0, Math.min(to, set.length - 1))
  const next = [...set]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/** Move one step up (-1) or down (+1); no change at either end. */
export function moveBy(set: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = set.indexOf(id)
  if (i < 0) return [...set]
  return moveWithin(set, i, i + delta)
}

export const isComplete = (set: readonly string[]) => set.length === SET_SIZE

/** The ids to send to POST /admin/categories/:id/publish, in slot order. Null until all five slots are filled. */
export function publishPayload(set: readonly string[]): string[] | null {
  return isComplete(set) ? [...set] : null
}

// ── Drag and drop ────────────────────────────────────────────────────────────────────────────────────

export type DropPlan =
  | { kind: 'add'; index: number }
  | { kind: 'reorder'; from: number; to: number }
  | { kind: 'remove' }
  | { kind: 'full' }
  | { kind: 'none' }

export const zoneOf = (set: readonly string[], id: string): Zone => (set.includes(id) ? 'set' : 'candidates')

/**
 * What dropping `activeId` on `overId` does. `overId` is a lever id, a zone id ('set' or 'candidates'),
 * or null (dropped outside both zones: nothing changes).
 */
export function planDrop(set: readonly string[], activeId: string, overId: string | null): DropPlan {
  if (overId === null) return { kind: 'none' }
  const from = zoneOf(set, activeId)
  const to: Zone = overId === 'set' || overId === 'candidates' ? overId : zoneOf(set, overId)
  if (from === 'candidates' && to === 'set') {
    if (set.length >= SET_SIZE) return { kind: 'full' }
    const i = set.indexOf(overId)
    return { kind: 'add', index: i >= 0 ? i : set.length }
  }
  if (from === 'set' && to === 'candidates') return { kind: 'remove' }
  if (from === 'set' && to === 'set') {
    const fromIndex = set.indexOf(activeId)
    const i = set.indexOf(overId)
    const toIndex = i >= 0 ? i : set.length - 1
    return fromIndex === toIndex ? { kind: 'none' } : { kind: 'reorder', from: fromIndex, to: toIndex }
  }
  return { kind: 'none' } // candidates are unordered
}

/** Apply a plan. A 'full' plan leaves the set unchanged (the UI says why). */
export function applyDrop(set: readonly string[], activeId: string, plan: DropPlan): string[] {
  switch (plan.kind) {
    case 'add': {
      const r = addToSet(set, activeId, plan.index)
      return r.set
    }
    case 'reorder':
      return moveWithin(set, plan.from, plan.to)
    case 'remove':
      return removeFromSet(set, activeId)
    case 'full':
    case 'none':
      return [...set]
  }
}
