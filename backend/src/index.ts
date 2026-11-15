import { app } from './app'
import { logger } from './lib/logger'
import { loadNudgeConfig } from './nudges/config'
import { startNudgeRuntime } from './nudges/runtime'

const PORT = process.env.PORT || 3001

// Fail fast on an invalid nudge configuration (e.g. NUDGE_EMAIL_PROVIDER=resend without a key)
// before accepting traffic.
loadNudgeConfig()

app.listen(PORT, () => {
  logger.info(`🚀 Verdict API running on http://localhost:${PORT}`)
  logger.info(`📖 API docs at http://localhost:${PORT}/api/docs`)

  // Nudge worker and reconciler
  if (process.env.NODE_ENV !== 'test') {
    startNudgeRuntime(process.env.REDIS_URL || 'redis://localhost:6379')
  }
})

export default app
