import { prisma } from '../lib/prisma'

const STAGE_ORDER = ['INITIAL', 'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS', 'CUSTOM']

export async function computeThreadDrift(threadId: string): Promise<number | null> {
  const reviews = await prisma.review.findMany({
    where: { threadId },
    select: { stage: true, scoreOverall: true, capturedAt: true },
    orderBy: { capturedAt: 'asc' },
  })

  if (reviews.length < 2) return null

  // Sort by stage order
  const sorted = reviews.sort((a, b) =>
    STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  )

  const initial = sorted[0].scoreOverall
  const latest = sorted[sorted.length - 1].scoreOverall
  const drift = latest - initial

  await prisma.reviewThread.update({
    where: { id: threadId },
    data: { driftScore: drift }
  })

  // Update product aggregate drift
  const thread = await prisma.reviewThread.findUnique({ where: { id: threadId } })
  if (thread) {
    const allThreads = await prisma.reviewThread.findMany({
      where: { productId: thread.productId, driftScore: { not: null } },
      select: { driftScore: true }
    })
    const avgDrift = allThreads.reduce((sum, t) => sum + (t.driftScore || 0), 0) / allThreads.length
    await prisma.product.update({
      where: { id: thread.productId },
      data: { driftScoreAvg: avgDrift }
    })
  }

  return drift
}
