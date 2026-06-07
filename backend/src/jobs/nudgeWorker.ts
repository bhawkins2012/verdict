import { Worker, Job } from 'bullmq'
import { prisma } from '../lib/prisma'
import { logger } from '../lib/logger'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export function startNudgeWorker() {
  const url = new URL(REDIS_URL)

  const worker = new Worker('nudges', async (job: Job) => {
    const { nudgeId, userId, threadId, stage } = job.data
    logger.info({ nudgeId, stage }, 'Processing nudge')

    const nudge = await prisma.nudge.findUnique({ where: { id: nudgeId } })
    if (!nudge || nudge.status !== 'PENDING') {
      logger.info({ nudgeId }, 'Nudge already processed or cancelled, skipping')
      return
    }

    // Mark as sent
    await prisma.nudge.update({
      where: { id: nudgeId },
      data: { status: 'SENT', sentAt: new Date() }
    })

    // TODO: Send actual notification (email/push)
    // For now, the nudge record in DB acts as the notification source
    // The frontend polls /api/nudges for pending items
    logger.info({ nudgeId, userId, stage }, 'Nudge marked as sent')

  }, {
    connection: { host: url.hostname, port: parseInt(url.port || '6379') },
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Nudge job failed')
  })

  return worker
}
