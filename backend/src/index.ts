import { app } from './app'
import { logger } from './lib/logger'
import { loadNudgeConfig } from './nudges/config'
import { startNudgeRuntime } from './nudges/runtime'
import { drainAccountEmails } from './auth/mailer'

const PORT = process.env.PORT || 3001

// Fail fast on an invalid nudge configuration (e.g. NUDGE_EMAIL_PROVIDER=resend without a key)
// before accepting traffic.
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
