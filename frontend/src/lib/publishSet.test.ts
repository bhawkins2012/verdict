import { describe, expect, it } from 'vitest'
import {
  addToSet, applyDrop, candidatesOf, initialSet, isComplete, moveBy, moveWithin, planDrop, publishPayload, removeFromSet, SET_SIZE,
} from './publishSet'

const lever = (id: string, status: 'CANDIDATE' | 'APPROVED' | 'RETIRED' = 'CANDIDATE', position: number | null = null) => ({ id, status, position })

describe('initial set and candidates', () => {
  it('starts from the published levers in position order', () => {
    const levers = [lever('c', 'APPROVED', 3), lever('x'), lever('a', 'APPROVED', 1), lever('r', 'RETIRED'), lever('b', 'APPROVED', 2)]
    expect(initialSet(levers)).toEqual(['a', 'b', 'c'])
  })

  it('candidates are the non-retired levers not in the set, in their original order', () => {
    const levers = [lever('a'), lever('r', 'RETIRED'), lever('b', 'APPROVED', 1), lever('c')]
    expect(candidatesOf(levers, ['b']).map((l) => l.id)).toEqual(['a', 'c'])
    expect(candidatesOf(levers, ['a', 'c']).map((l) => l.id)).toEqual(['b'])
  })
})

describe('add', () => {
  it('adds at the end, or at a given slot', () => {
    expect(addToSet(['a', 'b'], 'c')).toEqual({ ok: true, set: ['a', 'b', 'c'] })
    expect(addToSet(['a', 'b'], 'c', 0)).toEqual({ ok: true, set: ['c', 'a', 'b'] })
    expect(addToSet(['a', 'b'], 'c', 1)).toEqual({ ok: true, set: ['a', 'c', 'b'] })
    expect(addToSet(['a'], 'c', 99)).toEqual({ ok: true, set: ['a', 'c'] })
  })

  it('refuses a sixth lever and leaves the set unchanged', () => {
    const full = ['a', 'b', 'c', 'd', 'e']
    expect(SET_SIZE).toBe(5)
    expect(addToSet(full, 'f')).toEqual({ ok: false, set: full, reason: 'full' })
    expect(addToSet(full, 'f', 0)).toEqual({ ok: false, set: full, reason: 'full' })
  })

  it('refuses a lever already in the set', () => {
    expect(addToSet(['a', 'b'], 'a')).toEqual({ ok: false, set: ['a', 'b'], reason: 'already-in-set' })
  })

  it('never mutates its input', () => {
    const set = ['a', 'b']
    addToSet(set, 'c', 0)
    moveWithin(set, 0, 1)
    removeFromSet(set, 'a')
    expect(set).toEqual(['a', 'b'])
  })
})

describe('reorder and remove', () => {
  it('moves an item to a new index, keeping the others in order', () => {
    expect(moveWithin(['a', 'b', 'c', 'd', 'e'], 0, 3)).toEqual(['b', 'c', 'd', 'a', 'e'])
    expect(moveWithin(['a', 'b', 'c', 'd', 'e'], 4, 0)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(moveWithin(['a', 'b'], 0, 99)).toEqual(['b', 'a'])
    expect(moveWithin(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })

  it('moves one step up or down, and not past either end', () => {
    expect(moveBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(moveBy(['a', 'b'], 'zz', 1)).toEqual(['a', 'b'])
  })

  it('removes a lever, returning it to candidates', () => {
    expect(removeFromSet(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(candidatesOf([lever('a'), lever('b'), lever('c')], ['a', 'c']).map((l) => l.id)).toEqual(['b'])
  })
})

describe('publish', () => {
  it('is possible only with exactly five, and sends the ids in slot order', () => {
    expect(publishPayload(['a', 'b', 'c', 'd'])).toBeNull()
    expect(isComplete(['a', 'b', 'c', 'd'])).toBe(false)
    let set = ['a', 'b', 'c', 'd', 'e']
    set = moveWithin(set, 4, 0)
    set = moveBy(set, 'c', -1)
    expect(isComplete(set)).toBe(true)
    expect(publishPayload(set)).toEqual(['e', 'a', 'c', 'b', 'd'])
  })

  it('returns a copy, so later edits do not change a payload already sent', () => {
    const set = ['a', 'b', 'c', 'd', 'e']
    const payload = publishPayload(set)
    set.reverse()
    expect(payload).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('drag and drop plans', () => {
  const set = ['a', 'b', 'c']
  it('candidate onto a set card inserts at that slot; onto the set zone appends', () => {
    expect(planDrop(set, 'x', 'b')).toEqual({ kind: 'add', index: 1 })
    expect(planDrop(set, 'x', 'set')).toEqual({ kind: 'add', index: 3 })
    expect(applyDrop(set, 'x', planDrop(set, 'x', 'b'))).toEqual(['a', 'x', 'b', 'c'])
  })

  it('set card onto another set card reorders; onto itself does nothing', () => {
    expect(planDrop(set, 'a', 'c')).toEqual({ kind: 'reorder', from: 0, to: 2 })
    expect(applyDrop(set, 'a', planDrop(set, 'a', 'c'))).toEqual(['b', 'c', 'a'])
    expect(planDrop(set, 'b', 'b')).toEqual({ kind: 'none' })
  })

  it('set card onto Candidates (zone or a candidate card) removes it', () => {
    expect(planDrop(set, 'b', 'candidates')).toEqual({ kind: 'remove' })
    expect(planDrop(set, 'b', 'x')).toEqual({ kind: 'remove' })
    expect(applyDrop(set, 'b', { kind: 'remove' })).toEqual(['a', 'c'])
  })

  it('a sixth card is refused wherever it is dropped in the set', () => {
    const full = ['a', 'b', 'c', 'd', 'e']
    expect(planDrop(full, 'x', 'set')).toEqual({ kind: 'full' })
    expect(planDrop(full, 'x', 'c')).toEqual({ kind: 'full' })
    expect(applyDrop(full, 'x', { kind: 'full' })).toEqual(full)
  })

  it('dropping outside both zones, or candidate onto candidate, changes nothing', () => {
    expect(planDrop(set, 'x', null)).toEqual({ kind: 'none' })
    expect(planDrop(set, 'x', 'y')).toEqual({ kind: 'none' })
    expect(planDrop(set, 'x', 'candidates')).toEqual({ kind: 'none' })
  })
})
