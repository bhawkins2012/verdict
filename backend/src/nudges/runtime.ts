// Wires the nudge engine into the running API: config, provider, queue, worker and the reconciler timer.
import { Worker } from 'bullmq'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { loadNudgeConfig, NudgeConfig } from './config'
import { createProvider, EmailProvider } from './providers'
import { BullNudgeQueue, NUDGE_QUEUE_NAME, NudgeJobData, NudgeQueue, redisConnectionFromUrl } from './queue'
import { reconcileOnce } from './reconciler'
import { processNudge, ProcessOutcome, SenderDeps } from './sender'

export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000
const SWEEP_EVERY_N_RUNS = 12 // hourly

interface Runtime {
  config: NudgeConfig
  provider: EmailProvider
  queue: NudgeQueue | null
  worker: Worker<NudgeJobData> | null
  timer: NodeJS.Timeout | null
}

let runtime: Runtime | null = null

/** Sender dependencies: the running engine's, or built from the environment (tests, dev routes). */
export function senderDeps(): SenderDeps {
  if (runtime) return { db: prisma, provider: runtime.provider, config: runtime.config }
  const config = loadNudgeConfig()
  return { db: prisma, provider: createProvider(config), config }
}

export function processNudgeNow(nudgeId: string, opts: { ignoreCapAndHour?: boolean } = {}): Promise<ProcessOutcome> {
  return processNudge(nudgeId, senderDeps(), opts)
}

/**
 * After a transaction commits, schedule delivery jobs for these nudges. Best effort: if Redis is down
 * or the engine is not running, the reconciler picks them up.
 */
export function enqueueAfterCommit(nudgeIds: string[]): void {
  const queue = runtime?.queue
  if (!queue || nudgeIds.length === 0) return
  void (async () => {
    const nudges = await prisma.nudge.findMany({ where: { id: { in: nudgeIds }, status: 'PENDING' }, select: { id: true, sendAt: true } })
    for (const n of nudges) await queue.ensureJob(n.id, n.sendAt, new Date())
  })().catch((err) => logger.warn('Nudge enqueue failed; the reconciler will retry', { error: err instanceof Error ? err.message : String(err) }))
}

/** Start the worker and reconciler. Throws on invalid configuration (fail fast at startup). */
export function startNudgeRuntime(redisUrl: string): void {
  const config = loadNudgeConfig()
  if (!config.enabled) {
    logger.info('Nudges disabled (NUDGES_ENABLED=false)')
    return
  }
  const provider = createProvider(config)
  const connection = redisConnectionFromUrl(redisUrl)
  const queue = new BullNudgeQueue(redisUrl)
  const deps = (): SenderDeps => ({ db: prisma, provider, config })

  const worker = new Worker<NudgeJobData>(
    NUDGE_QUEUE_NAME,
    async (job) => {
      const outcome = await processNudge(job.data.nudgeId, deps())
      logger.info('Nudge job processed', { nudgeId: job.data.nudgeId, outcome: outcome.kind })
    },
    { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 5 }
  )
  let lastWorkerError = 0
  worker.on('error', (err) => {
    if (Date.now() - lastWorkerError > 60_000) {
      logger.warn('Nudge worker: Redis error (logged at most once a minute)', { error: err.message })
      lastWorkerError = Date.now()
    }
  })

  let runs = 0
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const report = await reconcileOnce(
        { db: prisma, queue, process: (id) => processNudge(id, deps()) },
        { sweep: runs % SWEEP_EVERY_N_RUNS === 0 }
      )
      runs++
      logger.info('Nudge reconciler run', { ...report })
    } catch (err) {
      logger.error('Nudge reconciler run failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS)
  timer.unref()
  void tick()

  runtime = { config, provider, queue, worker, timer }
  logger.info('Nudge engine started', { provider: provider.name, dailyCap: config.dailyCap, requireVerifiedEmail: config.requireVerifiedEmail })
}

export async function stopNudgeRuntime(): Promise<void> {
  if (!runtime) return
  if (runtime.timer) clearInterval(runtime.timer)
  await runtime.worker?.close()
  await runtime.queue?.close()
  runtime = null
}
