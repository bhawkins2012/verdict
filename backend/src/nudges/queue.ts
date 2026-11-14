// BullMQ delivery queue for nudges (docs/adr-nudges.md D2). Redis only decides when a worker wakes up;
// the database decides what is sent, so losing every job delays delivery but never loses or duplicates it.
import { Queue } from 'bullmq'
import { logger } from '../lib/logger'

export const NUDGE_QUEUE_NAME = 'nudges'

export interface RedisConnectionOptions {
  host: string
  port: number
  username?: string
  password?: string
  db?: number
  tls?: Record<string, never>
}

/**
 * Parse a redis:// or rediss:// URL into ioredis connection options, keeping the username, password,
 * database index and TLS. (The previous code passed only host and port, silently dropping the password.)
 */
export function redisConnectionFromUrl(url: string): RedisConnectionOptions {
  const u = new URL(url)
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must start with redis:// or rediss:// (got ${u.protocol}//)`)
  }
  const options: RedisConnectionOptions = {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 6379,
  }
  if (u.username) options.username = decodeURIComponent(u.username)
  if (u.password) options.password = decodeURIComponent(u.password)
  const dbPath = u.pathname.replace(/^\//, '')
  if (dbPath) {
    const db = Number(dbPath)
    if (!Number.isInteger(db) || db < 0) throw new Error(`REDIS_URL database index must be a non-negative integer (got "${dbPath}")`)
    options.db = db
  }
  if (u.protocol === 'rediss:') options.tls = {}
  return options
}

/** BullMQ job ids may not contain ':'. The id changes whenever sendAt changes (snooze, retry, deferral). */
export function jobIdFor(nudgeId: string, sendAt: Date): string {
  return `nudge-${nudgeId}-${sendAt.getTime()}`
}

export interface NudgeJobData {
  nudgeId: string
}

/** What the reconciler and routes need from a queue; a fake implements it in tests. */
export interface NudgeQueue {
  /** Make sure a live job exists for this nudge at this send time. Throws if Redis is unavailable. */
  ensureJob(nudgeId: string, sendAt: Date, now: Date): Promise<'exists' | 'added'>
  close(): Promise<void>
}

const LIVE_STATES = new Set(['delayed', 'waiting', 'waiting-children', 'prioritized', 'active'])
const REDIS_OP_TIMEOUT_MS = 3000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis ${what} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export class BullNudgeQueue implements NudgeQueue {
  private readonly queue: Queue<NudgeJobData>
  private lastErrorLog = 0

  constructor(redisUrl: string) {
    this.queue = new Queue<NudgeJobData>(NUDGE_QUEUE_NAME, {
      // Fail fast instead of buffering commands while Redis is down, so the reconciler can switch to
      // sending inline.
      connection: { ...redisConnectionFromUrl(redisUrl), enableOfflineQueue: false, maxRetriesPerRequest: 1 },
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    })
    this.queue.on('error', (err) => {
      const now = Date.now()
      if (now - this.lastErrorLog > 60_000) {
        logger.warn('Nudge queue: Redis error (logged at most once a minute)', { error: err.message })
        this.lastErrorLog = now
      }
    })
  }

  async ensureJob(nudgeId: string, sendAt: Date, now: Date): Promise<'exists' | 'added'> {
    const jobId = jobIdFor(nudgeId, sendAt)
    const existing = await withTimeout(this.queue.getJob(jobId), REDIS_OP_TIMEOUT_MS, 'getJob')
    if (existing) {
      const state = await withTimeout(existing.getState(), REDIS_OP_TIMEOUT_MS, 'getState')
      if (LIVE_STATES.has(state)) return 'exists'
      await withTimeout(existing.remove(), REDIS_OP_TIMEOUT_MS, 'remove')
    }
    await withTimeout(
      this.queue.add('send-nudge', { nudgeId }, { jobId, delay: Math.max(0, sendAt.getTime() - now.getTime()) }),
      REDIS_OP_TIMEOUT_MS,
      'add'
    )
    return 'added'
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}
