import { app } from './app'
import { logger } from './lib/logger'
import { startNudgeWorker } from './jobs/nudgeWorker'

const PORT = process.env.PORT || 3001

app.listen(PORT, () => {
  logger.info(`🚀 Verdict API running on http://localhost:${PORT}`)
  logger.info(`📖 API docs at http://localhost:${PORT}/api/docs`)

  // Start background job workers
  if (process.env.NODE_ENV !== 'test') {
    startNudgeWorker()
    logger.info('⏰ Nudge worker started')
  }
})

export default app
