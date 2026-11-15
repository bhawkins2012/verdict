import { prisma } from '../../src/lib/prisma'
import { MAX_SNOOZES, skipNudge, snoozeNudge, syncThreadNudges } from '../../src/nudges/lifecycle'
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
  it('first review plans the 2-week nudge, anchored on the thread start', async () => {
    const u = await apiUser()
    const product = await makeProduct()

    const res = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    expect(res.status).toBe(201)

    const thread = await prisma.reviewThread.findUniqueOrThrow({ where: { id: res.body.threadId } })
    const [n] = await nudgesOf(thread.id)
    expect(n).toMatchObject({ targetStage: 'TWO_WEEKS', status: 'PENDING' })
    expect(n.scheduledFor.getTime()).toBe(thread.startedAt.getTime() + days(14))
  })

  it('submitting the review for a stage marks its nudge COMPLETED and plans the next stage', async () => {
    const u = await apiUser()
    const product = await makeProduct()
    const first = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    const threadId = first.body.threadId
    const [weekNudge] = await nudgesOf(threadId)

    const res = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'TWO_WEEKS', scoreOverall: 7 })
    expect(res.status).toBe(201)

    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: weekNudge.id } })).toMatchObject({
      status: 'COMPLETED', endedReason: 'REVIEW_SUBMITTED', completedAt: expect.any(Date),
    })
    expect((await nudgesOf(threadId)).map((n) => [n.targetStage, n.status])).toEqual([
      ['TWO_WEEKS', 'COMPLETED'],
      ['THREE_MONTHS', 'PENDING'],
    ])
  })

  it('supersession: reviewing a later stage cancels the earlier pending nudge', async () => {
    const u = await apiUser()
    const product = await makeProduct()
    const first = await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'INITIAL', scoreOverall: 8 })
    const threadId = first.body.threadId

    // The user skips ahead and writes a 3-month review while the 2-week nudge is pending.
    await api().post('/api/reviews').set(bearer(u.accessToken)).send({ productId: product.id, stage: 'THREE_MONTHS', scoreOverall: 5 })

    expect((await nudgesOf(threadId)).map((n) => [n.targetStage, n.status, n.endedReason])).toEqual([
      ['TWO_WEEKS', 'CANCELLED', 'SUPERSEDED'],
      ['ONE_YEAR', 'PENDING', null],
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
    // Bought 40 days ago: 2 weeks is already due, 3 months is not -> one nudge, for 2 weeks.
    expect((await nudgesOf(thread.id)).map((n) => n.targetStage)).toEqual(['TWO_WEEKS'])
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

  it('anchoring when late: a 2-week review on day 50 leaves 3 months due at start + 3 months', async () => {
    const user = await makeUser()
    const day50 = new Date(start.getTime() + days(50))
    const thread = await makeThread(user.id, [
      { stage: 'INITIAL', at: start },
      { stage: 'TWO_WEEKS', at: day50 },
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
    const [weekId] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-25T00:00:00Z')))
    await prisma.nudge.update({ where: { id: weekId }, data: { status: 'SENT', channel: 'EMAIL', sentAt: new Date('2026-01-25T09:00:00Z') } })

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-04-11T00:00:00Z')))

    expect((await nudgesOf(thread.id)).map((n) => [n.targetStage, n.status])).toEqual([
      ['TWO_WEEKS', 'CANCELLED'],
      ['THREE_MONTHS', 'PENDING'],
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
    const now = new Date('2026-04-11T00:00:00Z')
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-25T00:00:00Z'))) // TWO_WEEKS
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now)) // THREE_MONTHS; TWO_WEEKS cancelled
    // A later purchase date makes 2 weeks the most relevant stage again (due Apr 8; 3 months not until Jun 25).
    await prisma.reviewThread.update({ where: { id: thread.id }, data: { purchasedAt: new Date('2026-03-25T00:00:00Z') } })
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))

    expect((await nudgesOf(thread.id)).map((n) => [n.targetStage, n.status])).toEqual([
      ['TWO_WEEKS', 'PENDING'],
      ['THREE_MONTHS', 'CANCELLED'],
    ])
  })

  it('a re-plan (e.g. the hourly sweep) never pulls a snoozed send time earlier', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-01-25T00:00:00Z') // 2 weeks is due
    const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
    await prisma.$transaction((tx) => snoozeNudge(tx, id, user.id, 30, now))
    const snoozed = await prisma.nudge.findUniqueOrThrow({ where: { id } })

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))

    const after = await prisma.nudge.findUniqueOrThrow({ where: { id } })
    expect(after.sendAt.getTime()).toBe(snoozed.sendAt.getTime())
    expect(after.sendAt.getTime()).toBeGreaterThanOrEqual(snoozed.snoozedUntil!.getTime())
  })

  it('concurrent snoozes cannot exceed the limit (the check and the update are one statement)', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const now = new Date('2026-01-25T00:00:00Z')
    const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
    await prisma.nudge.update({ where: { id }, data: { snoozeCount: MAX_SNOOZES - 1 } })

    const settled = await raceOnNudges([1, 2].map(() => () => prisma.$transaction((tx) => snoozeNudge(tx, id, user.id, 7, now))))

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id } })).snoozeCount).toBe(MAX_SNOOZES)
  })

  it('a nudge being sent (SENDING) cannot be skipped', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-25T00:00:00Z')))
    await prisma.nudge.update({ where: { id }, data: { status: 'SENDING', claimedAt: new Date() } })
    await expect(prisma.$transaction((tx) => skipNudge(tx, id, user.id, new Date()))).rejects.toMatchObject({ status: 409 })
  })

  it('re-timing (time zone or send hour changed) never pulls a snooze or a retry earlier', async () => {
    const user = await makeUser()
    const now = new Date('2026-01-25T00:00:00Z')
    const snoozedThread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const [snoozedId] = await prisma.$transaction((tx) => syncThreadNudges(tx, snoozedThread.id, now))
    await prisma.$transaction((tx) => snoozeNudge(tx, snoozedId, user.id, 30, now))
    const retryThread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const [retryId] = await prisma.$transaction((tx) => syncThreadNudges(tx, retryThread.id, now))
    const retryAt = new Date('2026-01-25T12:00:00Z')
    await prisma.nudge.update({ where: { id: retryId }, data: { attempts: 2, sendAt: retryAt } })

    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata', nudgeSendHour: 7 } })
    for (const t of [snoozedThread.id, retryThread.id]) await prisma.$transaction((tx) => syncThreadNudges(tx, t, now, { retime: true }))

    const snoozed = await prisma.nudge.findUniqueOrThrow({ where: { id: snoozedId } })
    expect(snoozed.sendAt.getTime()).toBeGreaterThanOrEqual(snoozed.snoozedUntil!.getTime())
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: retryId } })).sendAt.getTime()).toBeGreaterThanOrEqual(retryAt.getTime())
  })

  it('cadence change: existing nudges for stages outside the cadence are cancelled on the next planner pass', async () => {
    const user = await makeUser()
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    // Rows written under the old cadence (1 week, 1 month, 6 months), pending and delivered.
    for (const [stage, status] of [['ONE_WEEK', 'SENT'], ['ONE_MONTH', 'PENDING'], ['SIX_MONTHS', 'PENDING']] as const) {
      await prisma.nudge.create({ data: { userId: user.id, threadId: thread.id, targetStage: stage, status, scheduledFor: start, sendAt: start } })
    }

    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-25T00:00:00Z')))

    const rows = await prisma.nudge.findMany({ where: { threadId: thread.id } })
    const byStage = Object.fromEntries(rows.map((n) => [n.targetStage, [n.status, n.endedReason]]))
    expect(byStage).toEqual({
      ONE_WEEK: ['CANCELLED', 'SUPERSEDED'],
      ONE_MONTH: ['CANCELLED', 'SUPERSEDED'],
      SIX_MONTHS: ['CANCELLED', 'SUPERSEDED'],
      TWO_WEEKS: ['PENDING', null],
    })
  })
})
