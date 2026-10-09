import { api, bearer, cleanup, createProduct, registerUser } from './helpers'
import { prisma } from '../src/lib/prisma'

// Redis-backed scheduling and fire-and-forget drift are exercised elsewhere / not under test here.
jest.mock('../src/jobs/nudgeScheduler', () => ({ scheduleNudges: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../src/services/driftService', () => ({ computeThreadDrift: jest.fn().mockResolvedValue(null) }))

const userIds: string[] = []
const productIds: string[] = []
let fetchSpy: jest.SpyInstance

beforeEach(() => {
  // The ML service is not running in tests; simulate it being unavailable unless a test overrides.
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))
})
afterEach(() => fetchSpy.mockRestore())

afterAll(async () => {
  await cleanup(userIds, productIds)
  await prisma.$disconnect()
})

async function setup() {
  const user = await registerUser()
  const product = await createProduct()
  userIds.push(user.id)
  productIds.push(product.id)
  const post = (body: Record<string, unknown>, token = user.accessToken) =>
    api().post('/api/reviews').set(bearer(token)).send({ productId: product.id, scoreOverall: 7, ...body })
  return { user, product, post }
}

describe('POST /api/reviews: thread upsert', () => {
  it('creates the thread on the first review and reuses it for later stages', async () => {
    const { user, product, post } = await setup()

    const first = await post({ stage: 'INITIAL' })
    expect(first.status).toBe(201)

    let thread = await prisma.reviewThread.findUniqueOrThrow({
      where: { userId_productId: { userId: user.id, productId: product.id } },
    })
    expect(thread.stagesCompleted).toEqual(['INITIAL'])

    const second = await post({ stage: 'ONE_WEEK', scoreOverall: 5 })
    expect(second.status).toBe(201)
    expect(second.body.threadId).toBe(first.body.threadId)

    thread = await prisma.reviewThread.findUniqueOrThrow({ where: { id: first.body.threadId } })
    expect(thread.stagesCompleted).toEqual(['INITIAL', 'ONE_WEEK'])
    expect(await prisma.reviewThread.count({ where: { userId: user.id } })).toBe(1)
    expect(await prisma.review.count({ where: { threadId: thread.id } })).toBe(2)
  })

  it('keeps separate threads per product', async () => {
    const { user, post } = await setup()
    const other = await createProduct()
    productIds.push(other.id)

    await post({ stage: 'INITIAL' })
    const res = await post({ stage: 'INITIAL', productId: other.id })

    expect(res.status).toBe(201)
    expect(await prisma.reviewThread.count({ where: { userId: user.id } })).toBe(2)
  })
})

describe('POST /api/reviews: duplicate stage rejection', () => {
  it('rejects a repeated stage with 409 and leaves the thread unchanged', async () => {
    const { product, user, post } = await setup()
    await post({ stage: 'INITIAL' })

    const dup = await post({ stage: 'INITIAL', scoreOverall: 2 })

    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/already submitted/i)
    const thread = await prisma.reviewThread.findUniqueOrThrow({
      where: { userId_productId: { userId: user.id, productId: product.id } },
      include: { reviews: true },
    })
    expect(thread.reviews).toHaveLength(1)
    expect(thread.stagesCompleted).toEqual(['INITIAL'])
  })

  it('under concurrency, stores exactly one review and one stagesCompleted entry', async () => {
    const { product, user, post } = await setup()
    // Hold every request at the NLP call (after the duplicate pre-check, before the transaction)
    // so all of them pass the pre-check and race into the insert. Only the DB constraint can stop them.
    fetchSpy.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(new Response('unavailable', { status: 503 })), 300)))

    const results = await Promise.all(
      Array.from({ length: 6 }, () => post({ stage: 'INITIAL', bodyText: 'Concurrent submission, long enough for NLP.' }))
    )
    const statuses = results.map(r => r.status)

    expect(statuses.filter(s => s === 201)).toHaveLength(1)
    expect(statuses.filter(s => s === 409)).toHaveLength(5)
    const thread = await prisma.reviewThread.findUniqueOrThrow({
      where: { userId_productId: { userId: user.id, productId: product.id } },
      include: { reviews: true },
    })
    expect(thread.reviews).toHaveLength(1)
    expect(thread.stagesCompleted).toEqual(['INITIAL'])
  })
})

describe('POST /api/reviews: validation and auth', () => {
  it('requires authentication', async () => {
    const product = await createProduct()
    productIds.push(product.id)
    const res = await api().post('/api/reviews').send({ productId: product.id, stage: 'INITIAL', scoreOverall: 5 })
    expect(res.status).toBe(401)
  })

  it.each([
    ['score above 10', { scoreOverall: 11 }],
    ['score below 1', { scoreOverall: 0 }],
    ['non-integer score', { scoreOverall: 7.5 }],
    ['unknown stage', { stage: 'NEXT_DECADE' }],
  ])('rejects %s with 400', async (_name, override) => {
    const { post } = await setup()
    expect((await post({ stage: 'INITIAL', ...override })).status).toBe(400)
  })

  it('returns 404 for an unknown product', async () => {
    const { post } = await setup()
    expect((await post({ stage: 'INITIAL', productId: 'does-not-exist' })).status).toBe(404)
  })
})

describe('POST /api/reviews: NLP enrichment', () => {
  it('persists only the expected NLP fields and ignores anything else the ML service returns', async () => {
    const { user, product, post } = await setup()
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          sentimentScore: 0.5,
          keyTopics: ['quality'],
          summaryAuto: 'Nice',
          // Hostile / buggy extras that must never reach the Review row:
          threadId: 'attacker-thread',
          scoreOverall: 1,
          stage: 'TWO_YEARS',
          source: 'AMAZON',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await post({ stage: 'INITIAL', scoreOverall: 9, bodyText: 'Solid build and great value for money.' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ sentimentScore: 0.5, keyTopics: ['quality'], summaryAuto: 'Nice', scoreOverall: 9, stage: 'INITIAL', source: 'NATIVE' })
    const thread = await prisma.reviewThread.findUniqueOrThrow({
      where: { userId_productId: { userId: user.id, productId: product.id } },
    })
    expect(res.body.threadId).toBe(thread.id)
  })

  it('still saves the review when the ML service is down', async () => {
    const { post } = await setup()
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'))

    const res = await post({ stage: 'INITIAL', bodyText: 'Works fine so far, no complaints at all.' })

    expect(res.status).toBe(201)
    expect(res.body.sentimentScore).toBeNull()
  })

  it('drops an out-of-range sentiment score instead of storing it', async () => {
    const { post } = await setup()
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ sentimentScore: 7, keyTopics: [] }), { status: 200 }))

    const res = await post({ stage: 'INITIAL', bodyText: 'Decent enough product overall, I think.' })

    expect(res.status).toBe(201)
    expect(res.body.sentimentScore).toBeNull()
  })
})
