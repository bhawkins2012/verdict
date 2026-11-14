import { prisma } from '../../src/lib/prisma'
import { snoozeNudge, syncThreadNudges } from '../../src/nudges/lifecycle'
import { api, bearer, cleanup, registerUser } from '../helpers'
import { cleanupNudgeFixtures, days, makeProduct, makeThread, makeUser, raceOnNudges } from './fixtures'

jest.mock('../../src/services/driftService', () => ({ computeThreadDrift: jest.fn().mockResolvedValue(null) }))

const userIds: string[] = []

afterEach(cleanupNudgeFixtures)
afterAll(async () => {
  await cleanup(userIds)
  await prisma.$disconnect()
})

async function apiUser() {
  const u = await registerUser()
  userIds.push(u.id)
  return u
}

const nudgesOf = (threadId: string) =>
  prisma.nudge.findMany({ where: { threadId }, orderBy: { scheduledFor: 'asc' } })

describe('review submission drives the nudge lifecycle (through the API)', () => {
  it('first review plans the 1-week nudge, anchored on the thread start', async () => {
    const u = await apiUser()
    const product = await makeProduct()

    const res = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    expect(res.status).toBe(201)

    const thread = await prisma.reviewThread.findUniqueOrThrow({ where: { id: res.body.threadId } })
    const [n] = await nudgesOf(thread.id)
    expect(n).toMatchObject({ targetStage: 'ONE_WEEK', status: 'PENDING' })
    expect(n.scheduledFor.getTime()).toBe(thread.startedAt.getTime() + days(7))
  })

  it('submitting the review for a stage marks its nudge COMPLETED and plans the next stage', async () => {
    const u = await apiUser()
    const product = await makeProduct()
    const first = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    const threadId = first.body.threadId
    const [weekNudge] = await nudgesOf(threadId)

    const res = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'ONE_WEEK', scoreOverall: 7 })
    expect(res.status).toBe(201)

    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: weekNudge.id } })).toMatchObject({
      status: 'COMPLETED', endedReason: 'REVIEW_SUBMITTED', completedAt: expect.any(Date),
    })
    expect((await nudgesOf(threadId)).map((n) => [n.targetStage, n.status])).toEqual([
      ['ONE_WEEK', 'COMPLETED'],
      ['ONE_MONTH', 'PENDING'],
    ])
  })

  it('supersession: reviewing a later stage cancels the earlier pending nudge', async () => {
    const u = await apiUser()
    const product = await makeProduct()
    const first = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    const threadId = first.body.threadId

    // The user skips ahead and writes a 3-month review while the 1-week nudge is pending.
    await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'THREE_MONTHS', scoreOverall: 5 })

    expect((await nudgesOf(threadId)).map((n) => [n.targetStage, n.status, n.endedReason])).toEqual([
      ['ONE_WEEK', 'CANCELLED', 'SUPERSEDED'],
      ['SIX_MONTHS', 'PENDING', null],
    ])
  })

  it('purchase date: anchors the schedule; a future date is rejected', async () => {
    const u = await apiUser()
    const product = await makeProduct()
    const future = new Date(Date.now() + days(3)).toISOString().slice(0, 10)

    const rejected = await api().post('/api/reviews').set(bearer(u.accessToken))
      .send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8, purchasedAt: future })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toMatch(/future/)
    expect(await prisma.reviewThread.count({ where: { userId: u.id } })).toBe(0)

    const bought = new Date(Date.now() - days(40)).toISOString().slice(0, 10)
    const ok = await api().post('/api/reviews').set(bearer(u.accessToken))
      .send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8, purchasedAt: bought })
    expect(ok.status).toBe(201)
    const thread = await prisma.reviewThread.findUniqueOrThrow({ where: { id: ok.body.threadId } })
    expect(thread.purchasedAt?.toISOString().slice(0, 10)).toBe(bought)
    // Bought 40 days ago: 1 week and 1 month are already due -> one nudge, for 1 month.
    expect((await nudgesOf(thread.id)).map((n) => n.targetStage)).toEqual(['ONE_MONTH'])
  })

  it.each(['2026-02-30', 'yesterday', '2026-1-5'])('rejects a malformed purchase date (%j)', async (value) => {
    const u = await apiUser()
    const product = await makeProduct()
    const res = await api().post('/api/reviews').set(bearer(u.accessToken))
      .send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8, purchasedAt: value })
    expect(res.status).toBe(400)
  })
})

describe('syncThreadNudges', () => {
  const start = new Date('2026-01-10T10:00:00Z')

  it('anchoring when late: a 1-month review on day 50 leaves 3 months due at start + 3 months', async () => {
    const user = await makeUser()
    const day50 = new Date(start.getTime() + days(50))
    const thread = await makeThread(user.id, [
      { stage: 'INITIAL', at: start },
      { stage: 'ONE_MONTH', at: day50 },
    ])

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, day50))

    const [n] = await nudgesOf(thread.id)
    expect(n.targetStage).toBe('THREE_MONTHS')
    expect(n.scheduledFor.toISOString()).toBe('2026-04-10T10:00:00.000Z')
  })

  it('overdue collapse: only INITIAL, four months ago -> exactly one nudge, for 3 months', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-05-15T00:00:00Z')))
    expect((await nudgesOf(thread.id)).map((n) => [n.targetStage, n.status])).toEqual([['THREE_MONTHS', 'PENDING']])
  })

  it('time passing supersedes a delivered nudge once the next stage is due', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const [weekId] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-18T00:00:00Z')))
    await prisma.nudge.update({ where: { id: weekId }, data: { status: 'SENT', channel: 'EMAIL', sentAt: new Date('2026-01-18T09:00:00Z') } })

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-02-11T00:00:00Z')))

    expect((await nudgesOf(thread.id)).map((n) => [n.targetStage, n.status])).toEqual([
      ['ONE_WEEK', 'CANCELLED'],
      ['ONE_MONTH', 'PENDING'],
    ])
  })

  it('is idempotent: repeated syncs leave identical rows', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-05-15T00:00:00Z')
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
    const snapshot = (await nudgesOf(thread.id)).map(({ updatedAt: _u, ...rest }) => rest)

    for (let i = 0; i < 3; i++) await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))

    expect((await nudgesOf(thread.id)).map(({ updatedAt: _u, ...rest }) => rest)).toEqual(snapshot)
  })

  it('concurrent syncs of one thread do not fail or duplicate', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-05-15T00:00:00Z')
    // Forced race: all four read "no nudge yet" at the same instant, then all try to create it.
    const settled = await raceOnNudges(Array.from({ length: 4 }, () => () => prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))))
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([])
    expect(await prisma.nudge.count({ where: { threadId: thread.id } })).toBe(1)
  })

  it('a stage that becomes the target again (purchase date moved earlier) is revived', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-02-11T00:00:00Z')
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-18T00:00:00Z'))) // ONE_WEEK
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now)) // ONE_MONTH; ONE_WEEK cancelled
    // A later purchase date makes 1 week the most relevant stage again.
    await prisma.reviewThread.update({ where: { id: thread.id }, data: { purchasedAt: new Date('2026-02-01T00:00:00Z') } })
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))

    expect((await nudgesOf(thread.id)).map((n) => [n.targetStage, n.status])).toEqual([
      ['ONE_WEEK', 'PENDING'],
      ['ONE_MONTH', 'CANCELLED'],
    ])
  })

  it('a re-plan (e.g. the hourly sweep) never pulls a snoozed send time earlier', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-01-20T00:00:00Z') // 1 week is due
    const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
    await prisma.$transaction((tx) => snoozeNudge(tx, id, user.id, 30, now))
    const snoozed = await prisma.nudge.findUniqueOrThrow({ where: { id } })

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))

    const after = await prisma.nudge.findUniqueOrThrow({ where: { id } })
    expect(after.sendAt.getTime()).toBe(snoozed.sendAt.getTime())
    expect(after.sendAt.getTime()).toBeGreaterThanOrEqual(snoozed.snoozedUntil!.getTime())
  })
})
