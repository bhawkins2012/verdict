import { User } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { dueNudgesWhere, syncThreadNudges } from '../../src/nudges/lifecycle'
import { EmailProviderError } from '../../src/nudges/providers'
import { processNudge, RETRY_BACKOFF_MS } from '../../src/nudges/sender'
import { cleanupNudgeFixtures, days, makeThread, makeUser, mockProvider, raceOnNudges, senderDeps } from './fixtures'

const NOW = new Date('2026-11-14T12:00:00Z')

/** A user's thread with an overdue TWO_WEEKS nudge (started 40 days ago) whose send time has passed. */
async function dueNudge(user: User, productName?: string) {
  const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: new Date(NOW.getTime() - days(40)) }], { productName })
  const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, NOW))
  await prisma.nudge.update({ where: { id }, data: { sendAt: new Date(NOW.getTime() - 60_000) } })
  return prisma.nudge.findUniqueOrThrow({ where: { id } })
}

afterEach(cleanupNudgeFixtures)
afterAll(() => prisma.$disconnect())

describe('processNudge: the send-claim', () => {
  it('sends exactly once when several workers process the same nudge concurrently', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider()

    const settled = await raceOnNudges(Array.from({ length: 5 }, () => () => processNudge(nudge.id, senderDeps(provider, NOW))))
    const outcomes = settled.map((s) => (s.status === 'fulfilled' ? s.value : { kind: 'rejected' as const }))

    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.filter((o) => o.kind === 'sent')).toHaveLength(1)
    expect(outcomes.filter((o) => o.kind === 'not-claimed')).toHaveLength(4)
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'SENT', channel: 'EMAIL', attempts: 1 })
  })

  it('does not send before sendAt', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    await prisma.nudge.update({ where: { id: nudge.id }, data: { sendAt: new Date(NOW.getTime() + 60_000) } })
    const { provider, send } = mockProvider()

    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('not-claimed')
    expect(send).not.toHaveBeenCalled()
  })

  it('completes instead of sending when the stage was reviewed after it was scheduled', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    await prisma.review.create({ data: { threadId: nudge.threadId, stage: nudge.targetStage, scoreOverall: 6 } })
    const { provider, send } = mockProvider()

    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('completed')
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'COMPLETED', endedReason: 'REVIEW_SUBMITTED' })
  })

  it('never sends a stage outside the cadence (a job queued before the cadence changed), even before the sweep', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    // A legacy ONE_MONTH row whose BullMQ job fires before the planner sweep has cancelled it.
    await prisma.nudge.update({ where: { id: nudge.id }, data: { targetStage: 'ONE_MONTH' } })
    const { provider, send } = mockProvider()

    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('superseded')
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'CANCELLED', endedReason: 'SUPERSEDED' })
  })
})

describe('processNudge: consent and verification', () => {
  it('opted-out user: no email, but the check-in is still shown in-app', async () => {
    const user = await makeUser({ emailNudgesEnabled: false })
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider()

    expect(await processNudge(nudge.id, senderDeps(provider, NOW))).toEqual({ kind: 'in-app', reason: 'opted-out' })
    expect(send).not.toHaveBeenCalled()
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'SENT', channel: 'IN_APP' })
    expect(await prisma.nudge.count({ where: dueNudgesWhere(user.id, NOW) })).toBe(1)
  })

  it('real provider + unverified email + NUDGE_REQUIRE_VERIFIED_EMAIL: refused, in-app only', async () => {
    const user = await makeUser({ emailVerified: false })
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider({ real: true })

    expect(await processNudge(nudge.id, senderDeps(provider, NOW))).toEqual({ kind: 'in-app', reason: 'unverified-email' })
    expect(send).not.toHaveBeenCalled()
  })

  it('the dry-run provider is unaffected by email verification', async () => {
    const user = await makeUser({ emailVerified: false })
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider({ real: false })

    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a real provider sends to unverified users only if verification is explicitly not required', async () => {
    const user = await makeUser({ emailVerified: false })
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider({ real: true })

    expect((await processNudge(nudge.id, senderDeps(provider, NOW, { requireVerifiedEmail: false }))).kind).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('processNudge: daily cap', () => {
  it('second nudge the same local day is deferred to the next day\'s send hour', async () => {
    const user = await makeUser({ timezone: 'America/New_York', nudgeSendHour: 9 })
    const first = await dueNudge(user, 'Kettle')
    const second = await dueNudge(user, 'Toaster')
    const { provider, send } = mockProvider()

    expect((await processNudge(first.id, senderDeps(provider, NOW))).kind).toBe('sent')
    const deferred = await processNudge(second.id, senderDeps(provider, NOW))

    expect(send).toHaveBeenCalledTimes(1)
    // NOW is 07:00 in New York on Nov 14; the next local day's 09:00 is Nov 15 14:00Z.
    expect(deferred).toEqual({ kind: 'deferred', sendAt: new Date('2026-11-15T14:00:00Z') })
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'PENDING', attempts: 0 })

    // The next local day it goes out.
    expect((await processNudge(second.id, senderDeps(provider, new Date('2026-11-15T14:00:00Z')))).kind).toBe('sent')
  })

  it('holds under concurrency: two workers on two nudges of one user send one email', async () => {
    const user = await makeUser()
    const a = await dueNudge(user, 'Kettle')
    const b = await dueNudge(user, 'Toaster')
    const { provider, send } = mockProvider()

    // Forced race: both claims read the table at the same instant.
    const settled = await raceOnNudges([() => processNudge(a.id, senderDeps(provider, NOW)), () => processNudge(b.id, senderDeps(provider, NOW))])
    const outcomes = settled.map((s) => (s.status === 'fulfilled' ? s.value.kind : `rejected: ${String(s.reason)}`))

    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.sort()).toEqual(['deferred', 'sent'])
  })

  it("a dead worker's stale claim does not count toward the cap", async () => {
    const user = await makeUser()
    const stale = await dueNudge(user, 'Kettle')
    await prisma.nudge.update({ where: { id: stale.id }, data: { status: 'SENDING', claimedAt: new Date(NOW.getTime() - 11 * 60_000) } })
    const next = await dueNudge(user, 'Toaster')
    const { provider } = mockProvider()
    expect((await processNudge(next.id, senderDeps(provider, NOW))).kind).toBe('sent')
  })

  it('in-app-only notifications do not count toward the email cap', async () => {
    const optedOut = await makeUser({ emailNudgesEnabled: false })
    const inApp = await dueNudge(optedOut)
    const { provider } = mockProvider()
    await processNudge(inApp.id, senderDeps(provider, NOW))
    await prisma.user.update({ where: { id: optedOut.id }, data: { emailNudgesEnabled: true } })
    const next = await dueNudge(optedOut, 'Toaster')

    expect((await processNudge(next.id, senderDeps(provider, NOW))).kind).toBe('sent')
  })
})

describe('processNudge: failures', () => {
  it('a transient error retries with backoff, then dead-letters after the last attempt', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider({
      send: async () => {
        throw new EmailProviderError('Resend responded 503', true, 503)
      },
    })

    let now = NOW
    for (let attempt = 1; attempt <= 4; attempt++) {
      const outcome = await processNudge(nudge.id, senderDeps(provider, now))
      expect(outcome.kind).toBe('retry')
      const row = await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })
      expect(row).toMatchObject({ status: 'PENDING', attempts: attempt, lastError: expect.stringContaining('503') })
      expect(row.sendAt.getTime() - now.getTime()).toBe(RETRY_BACKOFF_MS[attempt - 1])
      now = row.sendAt
    }
    expect((await processNudge(nudge.id, senderDeps(provider, now))).kind).toBe('failed')
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'FAILED', attempts: 5 })
    expect(send).toHaveBeenCalledTimes(5)
    // A dead-lettered email is still shown in-app.
    expect(await prisma.nudge.count({ where: dueNudgesWhere(user.id, now) })).toBe(1)
  })

  it('a permanent error fails immediately without retrying', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider({
      send: async () => {
        throw new EmailProviderError('Resend responded 422: invalid to', false, 422)
      },
    })

    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('failed')
    expect(send).toHaveBeenCalledTimes(1)
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'FAILED', attempts: 1 })
  })

  it('a database error after the provider accepted the email is not treated as a failed send', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider, send } = mockProvider()
    // The provider accepts; then recording SENT fails (e.g. a brief database outage).
    const spy = jest.spyOn(prisma.nudge, 'updateMany').mockRejectedValueOnce(new Error('connection terminated'))
    try {
      const outcome = await processNudge(nudge.id, senderDeps(provider, NOW))
      expect(outcome.kind).toBe('sent')
    } finally {
      spy.mockRestore()
    }
    expect(send).toHaveBeenCalledTimes(1)
    // Left SENDING for the reconciler (at-least-once), not counted as a failed attempt or retried in 1 min.
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({ status: 'SENDING', attempts: 0, lastError: null })
  })

  it('a review submitted while the email is in flight: the nudge stays COMPLETED and the send is still recorded', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider } = mockProvider({
      send: async () => {
        await prisma.nudge.update({ where: { id: nudge.id }, data: { status: 'COMPLETED', endedReason: 'REVIEW_SUBMITTED' } })
        return { providerMessageId: 'mid-flight' }
      },
    })
    expect((await processNudge(nudge.id, senderDeps(provider, NOW))).kind).toBe('sent')
    expect(await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).toMatchObject({
      status: 'COMPLETED', channel: 'EMAIL', providerMessageId: 'mid-flight', sentAt: expect.any(Date),
    })
  })

  it('deferrals and in-app outcomes are not counted as attempts', async () => {
    const user = await makeUser({ emailNudgesEnabled: false })
    const nudge = await dueNudge(user)
    const { provider } = mockProvider()
    await processNudge(nudge.id, senderDeps(provider, NOW))
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).attempts).toBe(0)
  })
})
