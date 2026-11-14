import { prisma } from '../../src/lib/prisma'
import { loadNudgeConfig } from '../../src/nudges/config'
import { syncThreadNudges } from '../../src/nudges/lifecycle'
import { clearDryRunOutbox } from '../../src/nudges/providers'
import { signUnsubscribeToken } from '../../src/nudges/unsubscribe'
import { api, bearer, cleanup, registerUser } from '../helpers'
import { cleanupNudgeFixtures, days, makeThread } from './fixtures'

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

/** One thread per call; `dueDaysAgo` < 0 means the nudge is due in the future. */
async function nudgeFor(userId: string, dueDaysAgo: number) {
  const now = new Date()
  // INITIAL review 7+dueDaysAgo days ago => the 1-week nudge was due `dueDaysAgo` days ago.
  const thread = await makeThread(userId, [{ stage: 'INITIAL', at: new Date(now.getTime() - days(7 + dueDaysAgo)) }])
  await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, now))
  return prisma.nudge.findFirstOrThrow({ where: { threadId: thread.id } })
}

describe('GET /api/nudges and the stats count (one due-only source)', () => {
  it('lists only due check-ins, and the stats count matches the list', async () => {
    const u = await apiUser()
    const due = await nudgeFor(u.id, 2)
    await nudgeFor(u.id, -20) // due in 20 days: must not show
    const snoozed = await nudgeFor(u.id, 3)
    await prisma.nudge.update({ where: { id: snoozed.id }, data: { snoozedUntil: new Date(Date.now() + days(2)) } })

    const list = await api().get('/api/nudges').set(bearer(u.accessToken))
    const stats = await api().get('/api/users/me/stats').set(bearer(u.accessToken))

    expect(list.status).toBe(200)
    expect(list.body.map((n: { id: string }) => n.id)).toEqual([due.id])
    expect(list.body[0].thread.product.name).toEqual(expect.any(String))
    expect(stats.body.pendingNudges).toBe(list.body.length)
  })

  it('a delivered (SENT) or dead-lettered (FAILED) check-in stays listed until acted on', async () => {
    const u = await apiUser()
    const sent = await nudgeFor(u.id, 1)
    const failed = await nudgeFor(u.id, 2)
    await prisma.nudge.update({ where: { id: sent.id }, data: { status: 'SENT', channel: 'EMAIL', sentAt: new Date() } })
    await prisma.nudge.update({ where: { id: failed.id }, data: { status: 'FAILED' } })

    const list = await api().get('/api/nudges').set(bearer(u.accessToken))
    expect(list.body.map((n: { id: string }) => n.id).sort()).toEqual([sent.id, failed.id].sort())
  })
})

describe('skip and snooze', () => {
  it('skip hides the check-in for good and plans the next stage', async () => {
    const u = await apiUser()
    const n = await nudgeFor(u.id, 1)
    const res = await api().post(`/api/nudges/${n.id}/skip`).set(bearer(u.accessToken))
    expect(res.status).toBe(200)
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SKIPPED')
    expect((await prisma.nudge.findMany({ where: { threadId: n.threadId, status: 'PENDING' } })).map((x) => x.targetStage)).toEqual(['ONE_MONTH'])
  })

  it('skipping a check-in does not bring back an earlier stage it had superseded', async () => {
    const u = await apiUser()
    const thread = await makeThread(u.id, [{ stage: 'INITIAL', at: new Date(Date.now() - days(40)) }])
    await prisma.$transaction((tx) => syncThreadNudges(tx, thread.id, new Date()))
    const [monthNudge] = (await api().get('/api/nudges').set(bearer(u.accessToken))).body
    expect(monthNudge.targetStage).toBe('ONE_MONTH')

    await api().post(`/api/nudges/${monthNudge.id}/skip`).set(bearer(u.accessToken))

    expect((await api().get('/api/nudges').set(bearer(u.accessToken))).body).toEqual([])
    const active = await prisma.nudge.findMany({ where: { threadId: thread.id, status: 'PENDING' } })
    expect(active.map((n) => n.targetStage)).toEqual(['THREE_MONTHS'])
  })

  it('snooze hides it, moves the send time after the snooze, and is limited to 3', async () => {
    const u = await apiUser()
    const n = await nudgeFor(u.id, 1)
    for (let i = 1; i <= 3; i++) {
      const res = await api().post(`/api/nudges/${n.id}/snooze`).set(bearer(u.accessToken)).send({ days: 7 })
      expect(res.status).toBe(200)
      expect(res.body.snoozeCount).toBe(i)
    }
    const row = await prisma.nudge.findUniqueOrThrow({ where: { id: n.id } })
    expect(row.sendAt.getTime()).toBeGreaterThanOrEqual(row.snoozedUntil!.getTime())
    expect((await api().get('/api/nudges').set(bearer(u.accessToken))).body).toEqual([])
    expect((await api().post(`/api/nudges/${n.id}/snooze`).set(bearer(u.accessToken)).send({ days: 7 })).status).toBe(409)
    expect((await api().post(`/api/nudges/${n.id}/snooze`).set(bearer(u.accessToken)).send({ days: 3 })).status).toBe(400)
  })

  it("another user's nudge cannot be skipped, snoozed or sent", async () => {
    const owner = await apiUser()
    const intruder = await apiUser()
    const n = await nudgeFor(owner.id, 1)
    expect((await api().post(`/api/nudges/${n.id}/skip`).set(bearer(intruder.accessToken))).status).toBe(403)
    expect((await api().post(`/api/nudges/${n.id}/snooze`).set(bearer(intruder.accessToken)).send({ days: 7 })).status).toBe(403)
    expect((await api().post(`/api/nudges/${n.id}/send-now`).set(bearer(intruder.accessToken))).status).toBe(403)
    expect((await prisma.nudge.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('PENDING')
  })
})

describe('unsubscribe (no login)', () => {
  const secret = () => loadNudgeConfig().unsubscribeSecret
  const url = (u: string, t: string) => `/api/nudges/unsubscribe?${new URLSearchParams({ u, t }).toString()}`
  const optedIn = async () => {
    const u = await apiUser()
    await prisma.user.update({ where: { id: u.id }, data: { emailNudgesEnabled: true, emailNudgesConsentAt: new Date() } })
    return u
  }
  const enabled = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).emailNudgesEnabled

  it('GET with a valid link shows a confirmation and does NOT unsubscribe', async () => {
    const u = await optedIn()
    const res = await api().get(url(u.id, signUnsubscribeToken(secret(), u.id)))
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/<form method="post"/)
    await new Promise((r) => setTimeout(r, 300)) // a stray async write would have landed by now
    expect(await enabled(u.id)).toBe(true)
  })

  it('POST with a valid link unsubscribes and clears the consent time', async () => {
    const u = await optedIn()
    const res = await api().post(url(u.id, signUnsubscribeToken(secret(), u.id)))
    expect(res.status).toBe(200)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(user).toMatchObject({ emailNudgesEnabled: false, emailNudgesConsentAt: null })
  })

  it('RFC 8058 one-click POST (form body List-Unsubscribe=One-Click) works', async () => {
    const u = await optedIn()
    const res = await api().post(url(u.id, signUnsubscribeToken(secret(), u.id))).type('form').send('List-Unsubscribe=One-Click')
    expect(res.status).toBe(200)
    expect(await enabled(u.id)).toBe(false)
  })

  it.each([
    ['tampered token', (id: string, t: string) => url(id, (t[0] === 'A' ? 'B' : 'A') + t.slice(1))],
    ["another user's token", (id: string) => url(id, signUnsubscribeToken(secret(), 'someone-else'))],
    ['missing token', (id: string) => `/api/nudges/unsubscribe?u=${id}`],
    ['missing user', (_id: string, t: string) => `/api/nudges/unsubscribe?t=${t}`],
  ])('%s: 400 and nothing changes (GET and POST)', async (_name, build) => {
    const u = await optedIn()
    const link = build(u.id, signUnsubscribeToken(secret(), u.id))
    expect((await api().get(link)).status).toBe(400)
    expect((await api().post(link)).status).toBe(400)
    expect(await enabled(u.id)).toBe(true)
  })
})

describe('notification settings', () => {
  it('opt-in is off by default; enabling records consent, disabling clears it', async () => {
    const u = await apiUser()
    const initial = await api().get('/api/users/me/notification-settings').set(bearer(u.accessToken))
    expect(initial.body).toMatchObject({ emailNudgesEnabled: false, emailNudgesConsentAt: null, timezone: 'UTC', nudgeSendHour: 9 })

    const on = await api().put('/api/users/me/notification-settings').set(bearer(u.accessToken)).send({ emailNudgesEnabled: true, timezone: 'Asia/Kolkata' })
    expect(on.status).toBe(200)
    expect(on.body).toMatchObject({ emailNudgesEnabled: true, timezone: 'Asia/Kolkata', emailNudgesConsentAt: expect.any(String) })

    const off = await api().put('/api/users/me/notification-settings').set(bearer(u.accessToken)).send({ emailNudgesEnabled: false })
    expect(off.body).toMatchObject({ emailNudgesEnabled: false, emailNudgesConsentAt: null })
  })

  it.each([
    [{ timezone: 'Mars/Olympus' }],
    [{ nudgeSendHour: 24 }],
    [{ nudgeSendHour: 7.5 }],
    [{ emailVerified: true }], // not settable here
  ])('rejects %j', async (body) => {
    const u = await apiUser()
    expect((await api().put('/api/users/me/notification-settings').set(bearer(u.accessToken)).send(body)).status).toBe(400)
  })

  it('changing the time zone moves pending send times to the new local hour', async () => {
    const u = await apiUser()
    const n = await nudgeFor(u.id, -10)
    await api().put('/api/users/me/notification-settings').set(bearer(u.accessToken)).send({ timezone: 'Asia/Kolkata', nudgeSendHour: 9 })
    const after = await prisma.nudge.findUniqueOrThrow({ where: { id: n.id } })
    expect(after.sendAt.toISOString()).toMatch(/T03:30:00\.000Z$/) // 09:00 IST
  })
})

describe('development tools', () => {
  const original = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = original
  })

  it('send-now runs the real send path through the dry-run provider and records it', async () => {
    clearDryRunOutbox()
    const u = await apiUser()
    await prisma.user.update({ where: { id: u.id }, data: { emailNudgesEnabled: true } })
    const n = await nudgeFor(u.id, -10) // not due yet: send-now makes it due

    const res = await api().post(`/api/nudges/${n.id}/send-now`).set(bearer(u.accessToken))
    expect(res.status).toBe(200)
    expect(res.body.outcome.kind).toBe('sent')
    expect(res.body.nudge).toMatchObject({ status: 'SENT', channel: 'EMAIL' })

    const outbox = await api().get('/api/nudges/dev/outbox').set(bearer(u.accessToken))
    expect(outbox.body).toHaveLength(1)
    expect(outbox.body[0].text).toContain(`/products/`)
    expect(outbox.body[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('dev routes do not exist in production', async () => {
    const u = await apiUser()
    const n = await nudgeFor(u.id, 1)
    process.env.NODE_ENV = 'production'
    expect((await api().post(`/api/nudges/${n.id}/send-now`).set(bearer(u.accessToken))).status).toBe(404)
    expect((await api().get('/api/nudges/dev/outbox').set(bearer(u.accessToken))).status).toBe(404)
  })
})
