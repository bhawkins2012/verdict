import { app } from './app'
import { logger } from './lib/logger'
import { assertPrismaClientCurrent } from './lib/prismaClientGuard'
import { frontendUrlStartupMessages, resolveFrontendUrl } from './lib/frontendUrl'
import { createProvider } from './nudges/providers'
import { loadNudgeConfig } from './nudges/config'
import { startNudgeRuntime } from './nudges/runtime'
import { drainAccountEmails } from './auth/mailer'
import { loadLeverConfig } from './levers/config'
import { expireStaleRuns } from './levers/runs'

const PORT = process.env.PORT || 3001

// Fail fast, before accepting traffic, on a Prisma client generated from an older schema (it would fail
// later inside background tasks) and on an invalid nudge configuration.
try {
  assertPrismaClientCurrent()
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
const nudgeConfig = loadNudgeConfig()
// Lever generation: a live mode without ANTHROPIC_API_KEY, or a bad limit, stops startup (docs/adr-levers.md D3).
try {
  const leverConfig = loadLeverConfig()
  logger.info('Lever generation configured', { mode: leverConfig.mode, model: leverConfig.mode === 'live' ? leverConfig.model : 'dry-run', dailyLimit: leverConfig.dailyLimit })
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// Where emailed links and CORS point (no secrets), and a loud warning if real email would carry links
// that only work on this machine.
{
  const messages = frontendUrlStartupMessages(resolveFrontendUrl(), createProvider(nudgeConfig).real)
  logger.info(messages.info)
  if (messages.warn) logger.warn(messages.warn)
}

const server = app.listen(PORT, () => {
  logger.info(`🚀 Verdict API running on http://localhost:${PORT}`)
  logger.info(`📖 API docs at http://localhost:${PORT}/api/docs`)

  // Runs left RUNNING by a crash or restart are failed as timeouts once they are stale.
  void expireStaleRuns().catch((err) => logger.warn('Could not expire stale lever runs', { error: err instanceof Error ? err.message : String(err) }))

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
