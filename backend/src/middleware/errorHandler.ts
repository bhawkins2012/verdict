import { Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { logger } from '../lib/logger'

export class AppError extends Error {
  /** `details` are added to the JSON body next to `error` (for example per-row CSV errors). */
  constructor(public statusCode: number, message: string, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ ...err.details, error: err.message })
  }

  // Prisma unique constraint violation
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(409).json({ error: 'Resource already exists' })
  }

  logger.error('Unhandled error', { err, path: req.path, method: req.method })
  res.status(500).json({ error: 'Internal server error' })
}
