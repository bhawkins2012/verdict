// The reconciler (docs/adr-nudges.md D2). Runs at startup and every few minutes in every API instance.
// Every step is idempotent and the send-claim prevents double sends, so concurrent runs are safe.
import { PrismaClient } from '@prisma/client'
import { logger } from '../lib/logger'
import { syncThreadNudges } from './lifecycle'
import { NudgeQueue } from './queue'
import { ProcessOutcome, STALE_CLAIM_MS } from './sender'

export { STALE_CLAIM_MS }
export const ENQUEUE_HORIZON_MS = 24 * 60 * 60 * 1000
export const INLINE_BATCH = 50
const SWEEP_PAGE = 200

export interface ReconcileDeps {
  db: PrismaClient
  /** null when no queue is configured; treated like Redis being down. */
  queue: NudgeQueue | null
  process: (nudgeId: string) => Promise<ProcessOutcome>
  now?: () => Date
}

export interface ReconcileReport {
  recoveredClaims: number
  replannedThreads: number
  jobsExisting: number
  jobsAdded: number
  redisDown: boolean
  processedInline: number
  sentInline: number
}

export async function reconcileOnce(deps: ReconcileDeps, opts: { sweep?: boolean } = {}): Promise<ReconcileReport> {
  const now = (deps.now ?? (() => new Date()))()
  const report: ReconcileReport = {
    recoveredClaims: 0, replannedThreads: 0, jobsExisting: 0, jobsAdded: 0, redisDown: false, processedInline: 0, sentInline: 0,
  }

  // 1. A claim older than STALE_CLAIM_MS belongs to a worker that died: make the nudge sendable again.
  //    (If it died after the provider accepted the email, this re-sends it: at-least-once delivery.)
  const recovered = await deps.db.nudge.updateMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: 'PENDING', claimedAt: null },
  })
  report.recoveredClaims = recovered.count

  // 2. Re-plan threads (catches stages that became due and superseded earlier ones, and repairs any
  //    drift from crashes between commit and enqueue).
  if (opts.sweep) {
    let cursor: string | undefined
    for (;;) {
      const threads = await deps.db.reviewThread.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (threads.length === 0) break
      for (const t of threads) {
        await deps.db.$transaction((tx) => syncThreadNudges(tx, t.id, now))
        report.replannedThreads++
      }
      cursor = threads[threads.length - 1].id
    }
  }

  // 3. Every PENDING nudge due within the horizon must have a live job.
  const pending = await deps.db.nudge.findMany({
    where: { status: 'PENDING', sendAt: { lte: new Date(now.getTime() + ENQUEUE_HORIZON_MS) } },
    select: { id: true, sendAt: true },
    orderBy: { sendAt: 'asc' },
  })
  if (!deps.queue) {
    report.redisDown = true
  } else {
    for (const n of pending) {
      try {
        const result = await deps.queue.ensureJob(n.id, n.sendAt, now)
        if (result === 'added') report.jobsAdded++
        else report.jobsExisting++
      } catch (err) {
        report.redisDown = true
        logger.warn('Nudge reconciler: queue unavailable, sending due nudges inline', {
          error: err instanceof Error ? err.message : String(err),
        })
        break
      }
    }
  }

  // 4. Redis down: deliver what is due ourselves, through the same claim (so no double send).
  if (report.redisDown) {
    const due = pending.filter((n) => n.sendAt.getTime() <= now.getTime()).slice(0, INLINE_BATCH)
    for (const n of due) {
      const outcome = await deps.process(n.id)
      report.processedInline++
      if (outcome.kind === 'sent') report.sentInline++
    }
  }

  return report
}
