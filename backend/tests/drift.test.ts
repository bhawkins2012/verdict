import { ReviewStage } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { computeThreadDrift } from '../src/services/driftService'
import { cleanup, createProduct, registerUser } from './helpers'

const userIds: string[] = []
const productIds: string[] = []

afterAll(async () => {
  await cleanup(userIds, productIds)
  await prisma.$disconnect()
})

async function makeThread(userId: string, productId: string, reviews: Array<{ stage: ReviewStage; score: number; capturedAt?: Date }>) {
  const thread = await prisma.reviewThread.create({ data: { userId, productId, stagesCompleted: reviews.map(r => r.stage) } })
  for (const r of reviews) {
    await prisma.review.create({
      data: { threadId: thread.id, stage: r.stage, scoreOverall: r.score, capturedAt: r.capturedAt ?? new Date() },
    })
  }
  return thread
}

describe('computeThreadDrift', () => {
  it('returns null and stores nothing for a single review', async () => {
    const user = await registerUser(); userIds.push(user.id)
    const product = await createProduct(); productIds.push(product.id)
    const thread = await makeThread(user.id, product.id, [{ stage: 'INITIAL', score: 8 }])

    expect(await computeThreadDrift(thread.id)).toBeNull()
    expect((await prisma.reviewThread.findUniqueOrThrow({ where: { id: thread.id } })).driftScore).toBeNull()
  })

  it('is latest minus initial, negative when the product disappoints over time', async () => {
    const user = await registerUser(); userIds.push(user.id)
    const product = await createProduct(); productIds.push(product.id)
    const thread = await makeThread(user.id, product.id, [
      { stage: 'INITIAL', score: 9 },
      { stage: 'ONE_MONTH', score: 6 },
      { stage: 'ONE_YEAR', score: 4 },
    ])

    expect(await computeThreadDrift(thread.id)).toBe(-5)
    expect((await prisma.reviewThread.findUniqueOrThrow({ where: { id: thread.id } })).driftScore).toBe(-5)
  })

  it('is positive when opinion improves', async () => {
    const user = await registerUser(); userIds.push(user.id)
    const product = await createProduct(); productIds.push(product.id)
    const thread = await makeThread(user.id, product.id, [
      { stage: 'INITIAL', score: 5 },
      { stage: 'ONE_WEEK', score: 8 },
    ])

    expect(await computeThreadDrift(thread.id)).toBe(3)
  })

  it('orders by stage, not by the time the review was captured', async () => {
    const user = await registerUser(); userIds.push(user.id)
    const product = await createProduct(); productIds.push(product.id)
    const now = Date.now()
    // The one-year review was entered first (e.g. backfilled), the initial review last.
    const thread = await makeThread(user.id, product.id, [
      { stage: 'ONE_YEAR', score: 3, capturedAt: new Date(now - 2000) },
      { stage: 'INITIAL', score: 9, capturedAt: new Date(now) },
    ])

    expect(await computeThreadDrift(thread.id)).toBe(-6)
  })

  it("updates the product's average drift across threads", async () => {
    const product = await createProduct(); productIds.push(product.id)
    const a = await registerUser(); userIds.push(a.id)
    const b = await registerUser(); userIds.push(b.id)
    const threadA = await makeThread(a.id, product.id, [{ stage: 'INITIAL', score: 8 }, { stage: 'ONE_YEAR', score: 4 }]) // -4
    const threadB = await makeThread(b.id, product.id, [{ stage: 'INITIAL', score: 5 }, { stage: 'ONE_YEAR', score: 7 }]) // +2

    await computeThreadDrift(threadA.id)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).driftScoreAvg).toBe(-4)

    await computeThreadDrift(threadB.id)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).driftScoreAvg).toBe(-1)
  })
})
