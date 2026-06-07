import { Queue } from 'bullmq'
import { ReviewStage } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'
import { addWeeks, addMonths } from 'date-fns'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

let nudgeQueue: Queue | null = null

function getNudgeQueue(): Queue {
  if (!nudgeQueue) {
    const url = new URL(REDIS_URL)
    nudgeQueue = new Queue('nudges', {
      connection: { host: url.hostname, port: parseInt(url.port || '6379') }
    })
  }
  return nudgeQueue
}

// Map: current stage → next stage + delay
const NEXT_STAGE_MAP: Record<string, { stage: ReviewStage; delayMs: number }> = {
  INITIAL:       { stage: ReviewStage.ONE_WEEK,      delayMs: 7 * 24 * 60 * 60 * 1000 },
  ONE_WEEK:      { stage: ReviewStage.ONE_MONTH,     delayMs: 23 * 24 * 60 * 60 * 1000 },
  ONE_MONTH:     { stage: ReviewStage.THREE_MONTHS,  delayMs: 60 * 24 * 60 * 60 * 1000 },
  THREE_MONTHS:  { stage: ReviewStage.SIX_MONTHS,    delayMs: 90 * 24 * 60 * 60 * 1000 },
  SIX_MONTHS:    { stage: ReviewStage.ONE_YEAR,      delayMs: 183 * 24 * 60 * 60 * 1000 },
  ONE_YEAR:      { stage: ReviewStage.TWO_YEARS,     delayMs: 365 * 24 * 60 * 60 * 1000 },
}

export async function scheduleNudges(
  threadId: string,
  completedStage: ReviewStage,
  userId: string
): Promise<void> {
  const next = NEXT_STAGE_MAP[completedStage]
  if (!next) return // No more stages to schedule

  const scheduledFor = new Date(Date.now() + next.delayMs)

  // Create nudge record
  const nudge = await prisma.nudge.create({
    data: {
      userId,
      threadId,
      targetStage: next.stage,
      scheduledFor,
      status: 'PENDING',
    }
  })

  // Enqueue in BullMQ with delay
  try {
    const queue = getNudgeQueue()
    await queue.add('send-nudge', { nudgeId: nudge.id, userId, threadId, stage: next.stage }, {
      delay: next.delayMs,
      jobId: `nudge-${nudge.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
    })
    logger.info({ nudgeId: nudge.id, stage: next.stage, scheduledFor }, 'Nudge scheduled')
  } catch (err) {
    logger.warn({ err }, 'Failed to enqueue nudge (Redis may not be available)')
    // Nudge is still in DB — can be picked up by cron fallback
  }
}
