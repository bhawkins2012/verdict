import { prisma } from '../lib/prisma'
import { stageRank } from '../stages'

export async function computeThreadDrift(threadId: string): Promise<number | null> {
  const reviews = await prisma.review.findMany({
    where: { threadId },
    select: { stage: true, scoreOverall: true, capturedAt: true },
    orderBy: { capturedAt: 'asc' },
  })

  if (reviews.length < 2) return null

  // Sort by stage order
  const sorted = reviews.sort((a, b) =>
    rankForDrift(a.stage) - rankForDrift(b.stage)
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

/** Chronological order for drift; CUSTOM (no place on the timeline) sorts last. */
function rankForDrift(stage: Parameters<typeof stageRank>[0]): number {
  const rank = stageRank(stage)
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank
}
