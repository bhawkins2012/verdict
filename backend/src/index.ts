import 'dotenv/config'
import 'express-async-errors' // must load before any router is created: forwards async handler rejections to errorHandler
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import { authRouter } from './routes/auth'
import { usersRouter } from './routes/users'
import { productsRouter } from './routes/products'
import { reviewsRouter } from './routes/reviews'
import { recommendationsRouter } from './routes/recommendations'
import { nudgesRouter } from './routes/nudges'
import { errorHandler } from './middleware/errorHandler'
import { setupSwagger } from './lib/swagger'
import { logger } from './lib/logger'
import { startNudgeWorker } from './jobs/nudgeWorker'

const app = express()
const PORT = process.env.PORT || 3001

// ── Security & Middleware ──────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}))
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }))
app.use(express.json({ limit: '10mb' }))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/api', limiter)

// ── Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRouter)
app.use('/api/users', usersRouter)
app.use('/api/products', productsRouter)
app.use('/api/reviews', reviewsRouter)
app.use('/api/recommendations', recommendationsRouter)
app.use('/api/nudges', nudgesRouter)

// ── Health Check ───────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' })
})

// ── Swagger Docs ───────────────────────────────────────────
setupSwagger(app)

// ── Error Handler ──────────────────────────────────────────
app.use(errorHandler)

// ── Start ──────────────────────────────────────────────────
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
