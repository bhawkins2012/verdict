import { app } from './app'
import { logger } from './lib/logger'
import { assertPrismaClientCurrent } from './lib/prismaClientGuard'
import { loadNudgeConfig } from './nudges/config'
import { startNudgeRuntime } from './nudges/runtime'
import { drainAccountEmails } from './auth/mailer'

const PORT = process.env.PORT || 3001

// Fail fast, before accepting traffic, on a Prisma client generated from an older schema (it would fail
// later inside background tasks) and on an invalid nudge configuration.
try {
  assertPrismaClientCurrent()
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
loadNudgeConfig()

const server = app.listen(PORT, () => {
  logger.info(`🚀 Verdict API running on http://localhost:${PORT}`)
  logger.info(`📖 API docs at http://localhost:${PORT}/api/docs`)

  // Nudge worker and reconciler
  if (process.env.NODE_ENV !== 'test') {
    startNudgeRuntime(process.env.REDIS_URL || 'redis://localhost:6379')
  }
})

// Graceful shutdown: stop accepting requests and give account emails queued after a response (e.g. a
// verification link) a few seconds to go out. A send that never happens frees its address slot after
// UNSENT_SLOT_GRACE_MS anyway, so Resend still works.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info('Shutting down', { signal })
    server.close()
    void drainAccountEmails(10_000).then((drained) => {
      if (!drained) logger.warn('Account emails still in flight at shutdown')
      process.exit(0)
    })
  })
}

export default app
