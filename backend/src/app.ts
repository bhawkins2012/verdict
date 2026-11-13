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
import { parseTrustProxy } from './lib/trustProxy'

export const app = express()

// Behind a reverse proxy the client address is in X-Forwarded-For. Tell Express how many proxy hops to
// trust (TRUST_PROXY, default 1) so req.ip, and therefore rate limiting, is per client rather than per proxy.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))

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
  max: Number(process.env.RATE_LIMIT_MAX) || 200,
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

export default app
