import { app } from './app'
import { logger } from './lib/logger'
import { assertPrismaClientCurrent } from './lib/prismaClientGuard'
import { frontendUrlStartupMessages, resolveFrontendUrl } from './lib/frontendUrl'
import { createProvider } from './nudges/providers'
import { loadNudgeConfig } from './nudges/config'
import { startNudgeRuntime } from './nudges/runtime'
import { drainAccountEmails } from './auth/mailer'
import { loadGenerationConfig } from './generation/config'
import { drainGenerationRuns, startGenerationReconciler } from './generation/runs'

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
// Generation runs: a live mode without ANTHROPIC_API_KEY, or a bad cap, stops startup (docs/adr-generation-run.md D5.6).
try {
  const g = loadGenerationConfig()
  logger.info('Generation configured', { mode: g.mode, model: g.mode === 'live' ? g.model : 'dry-run', runCapUsd: g.runCapUsd, dailyCapUsd: g.dailyCapUsd })
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

  // Generation: stages that stopped heartbeating are marked STALLED (an admin resumes them), and fetched page
  // text older than 24 hours is deleted. At startup and every minute.
  if (process.env.NODE_ENV !== 'test') startGenerationReconciler()

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
    void Promise.all([drainAccountEmails(10_000), drainGenerationRuns(10_000)]).then(([emails, runs]) => {
      if (!emails) logger.warn('Account emails still in flight at shutdown')
      if (!runs) logger.warn('Generation work still in flight at shutdown; its stage will be marked stalled and can be resumed')
      process.exit(0)
    })
  })
}

export default app
