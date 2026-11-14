import { User } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { syncThreadNudges } from '../../src/nudges/lifecycle'
import { jobIdFor, NudgeQueue } from '../../src/nudges/queue'
import { reconcileOnce, STALE_CLAIM_MS } from '../../src/nudges/reconciler'
import { processNudge } from '../../src/nudges/sender'
import { cleanupNudgeFixtures, days, makeThread, makeUser, mockProvider, senderDeps } from './fixtures'

const NOW = new Date('2026-11-14T12:00:00Z')

/** In-memory stand-in for BullMQ: a set of job ids. `down` simulates Redis being unreachable. */
class FakeQueue implements NudgeQueue {
  jobs = new Set<string>()
  down = false
  added = 0
  async ensureJob(nudgeId: string, sendAt: Date): Promise<'exists' | 'added'> {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
    const id = jobIdFor(nudgeId, sendAt)
    if (this.jobs.has(id)) return 'exists'
    this.jobs.add(id)
    this.added++
    return 'added'
  }
  async close() {}
}

async function dueNudge(user: User, productName?: string) {
  const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: new Date(NOW.getTime() - days(40)) }], { productName })
  const [id] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, NOW))
  await prisma.nudge.update({ where: { id }, data: { sendAt: new Date(NOW.getTime() - 60_000) } })
  return prisma.nudge.findUniqueOrThrow({ where: { id } })
}

const rowsOf = (userId: string) =>
  prisma.nudge.findMany({ where: { userId }, orderBy: { id: 'asc' } }).then((rows) => rows.map(({ updatedAt: _u, ...r }) => r))

afterEach(cleanupNudgeFixtures)
afterAll(() => prisma.$disconnect())

describe('reconcileOnce', () => {
  it('is idempotent: a second run (with sweep) adds no jobs and changes no rows', async () => {
    const user = await makeUser()
    await dueNudge(user, 'Kettle')
    await dueNudge(user, 'Toaster')
    const queue = new FakeQueue()
    const { provider, send } = mockProvider()
    const deps = { db: prisma, queue, process: (id: string) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW }

    const first = await reconcileOnce(deps, { sweep: true })
    const rowsAfterFirst = await rowsOf(user.id)
    const jobsAfterFirst = new Set(queue.jobs)
    const second = await reconcileOnce(deps, { sweep: true })

    expect(first.redisDown).toBe(false)
    expect(second.jobsAdded).toBe(0)
    expect(queue.jobs).toEqual(jobsAfterFirst)
    expect(await rowsOf(user.id)).toEqual(rowsAfterFirst)
    expect(send).not.toHaveBeenCalled() // with Redis up, sending is the worker's job
  })

  it('re-creates a missing job exactly once', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const queue = new FakeQueue()
    const deps = { db: prisma, queue, process: async () => ({ kind: 'not-claimed' as const }), now: () => NOW }
    await reconcileOnce(deps)
    const jobId = jobIdFor(nudge.id, nudge.sendAt)
    expect(queue.jobs.has(jobId)).toBe(true)

    queue.jobs.delete(jobId) // Redis lost the job
    const addedBefore = queue.added
    await reconcileOnce(deps)
    await reconcileOnce(deps)

    expect(queue.jobs.has(jobId)).toBe(true)
    expect(queue.added - addedBefore).toBe(1)
  })

  it('returns a stale claim (dead worker) to PENDING, but leaves a fresh claim alone', async () => {
    const user = await makeUser()
    const stale = await dueNudge(user, 'Kettle')
    const fresh = await dueNudge(user, 'Toaster')
    await prisma.nudge.update({ where: { id: stale.id }, data: { status: 'SENDING', claimedAt: new Date(NOW.getTime() - STALE_CLAIM_MS - 1000) } })
    await prisma.nudge.update({ where: { id: fresh.id }, data: { status: 'SENDING', claimedAt: new Date(NOW.getTime() - 60_000) } })

    const report = await reconcileOnce({ db: prisma, queue: new FakeQueue(), process: async () => ({ kind: 'not-claimed' as const }), now: () => NOW })

    expect(report.recoveredClaims).toBeGreaterThanOrEqual(1)
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('PENDING')
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('SENDING')
  })

  it('crash after the provider accepted the email: the recovered claim is sent again (at-least-once), with the same idempotency key', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const { provider, sent } = mockProvider()
    // First attempt "sent" the email, then the worker died before marking SENT.
    await provider.send({ to: user.email, from: 'x', subject: 'x', text: 'x', html: 'x', headers: {}, idempotencyKey: `nudge/${nudge.id}` })
    await prisma.nudge.update({ where: { id: nudge.id }, data: { status: 'SENDING', claimedAt: new Date(NOW.getTime() - STALE_CLAIM_MS - 1000) } })

    const queue = new FakeQueue()
    queue.down = true
    await reconcileOnce({ db: prisma, queue, process: (id) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW })

    expect(sent).toHaveLength(2)
    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey)
  })
})

describe('reconcileOnce sweep', () => {
  it('re-plans threads: once the next stage is due, the delivered earlier nudge is superseded', async () => {
    const user = await makeUser()
    const start = new Date('2026-01-10T10:00:00Z')
    const thread = await makeThread(user.id, [{ stage: 'INITIAL', at: start }])
    const [weekId] = await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date('2026-01-18T00:00:00Z')))
    await prisma.nudge.update({ where: { id: weekId }, data: { status: 'SENT', channel: 'EMAIL', sentAt: new Date('2026-01-18T09:00:00Z') } })

    const later = new Date('2026-02-11T00:00:00Z') // 1 month is now due
    await reconcileOnce({ db: prisma, queue: new FakeQueue(), process: async () => ({ kind: 'not-claimed' as const }), now: () => later }, { sweep: true })

    const rows = await prisma.nudge.findMany({ where: { threadId: thread.id }, orderBy: { scheduledFor: 'asc' } })
    expect(rows.map((n) => [n.targetStage, n.status])).toEqual([
      ['ONE_WEEK', 'CANCELLED'],
      ['ONE_MONTH', 'PENDING'],
    ])
  })
})

describe('reconcileOnce sweep does not delay delivery (review finding 1)', () => {
  it('a sweep keeps the send time of a nudge that is already due', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    await reconcileOnce({ db: prisma, queue: new FakeQueue(), process: async () => ({ kind: 'not-claimed' as const }), now: () => NOW }, { sweep: true })
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).sendAt.getTime()).toBe(nudge.sendAt.getTime())
  })

  it('a sweep keeps a retry backoff time', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    const retryAt = new Date(NOW.getTime() + 60_000)
    await prisma.nudge.update({ where: { id: nudge.id }, data: { attempts: 1, sendAt: retryAt } })
    await reconcileOnce({ db: prisma, queue: new FakeQueue(), process: async () => ({ kind: 'not-claimed' as const }), now: () => NOW }, { sweep: true })
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })).sendAt.getTime()).toBe(retryAt.getTime())
  })

  it('Redis down + a sweep in the same run still sends the due nudge inline', async () => {
    const user = await makeUser()
    await dueNudge(user)
    const { provider, send } = mockProvider()
    await reconcileOnce({ db: prisma, queue: null, process: (id) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW }, { sweep: true })
    expect(send.mock.calls.filter(([m]) => m.to === user.email)).toHaveLength(1)
  })
})

describe('reconcileOnce with Redis down', () => {
  it('sends due nudges inline, once; a second run sends nothing more', async () => {
    const user = await makeUser()
    await dueNudge(user)
    const queue = new FakeQueue()
    queue.down = true
    const { provider, send } = mockProvider()
    const deps = { db: prisma, queue, process: (id: string) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW }

    const first = await reconcileOnce(deps)
    await reconcileOnce(deps)

    expect(first.redisDown).toBe(true)
    expect(send.mock.calls.filter(([m]) => m.to === user.email)).toHaveLength(1)
  })

  it('no queue configured behaves like Redis down', async () => {
    const user = await makeUser()
    await dueNudge(user)
    const { provider, send } = mockProvider()
    const report = await reconcileOnce({ db: prisma, queue: null, process: (id) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW })
    expect(report.redisDown).toBe(true)
    expect(send.mock.calls.filter(([m]) => m.to === user.email)).toHaveLength(1)
  })

  it('two reconcilers running at the same time still send each nudge once', async () => {
    const user = await makeUser()
    await dueNudge(user)
    const { provider, send } = mockProvider()
    const deps = () => {
      const q = new FakeQueue()
      q.down = true
      return { db: prisma, queue: q, process: (id: string) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW }
    }
    await Promise.all([reconcileOnce(deps()), reconcileOnce(deps())])
    expect(send.mock.calls.filter(([m]) => m.to === user.email)).toHaveLength(1)
  })

  it('does not send nudges that are not due yet', async () => {
    const user = await makeUser()
    const nudge = await dueNudge(user)
    await prisma.nudge.update({ where: { id: nudge.id }, data: { sendAt: new Date(NOW.getTime() + 60 * 60_000) } })
    const { provider, send } = mockProvider()
    await reconcileOnce({ db: prisma, queue: null, process: (id) => processNudge(id, senderDeps(provider, NOW)), now: () => NOW })
    expect(send).not.toHaveBeenCalled()
  })
})
