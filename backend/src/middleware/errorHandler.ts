import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger'

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message })
  }

  // Prisma unique constraint violation
  if ((err as any).code === 'P2002') {
    return res.status(409).json({ error: 'Resource already exists' })
  }

  logger.error('Unhandled error', { err, path: req.path, method: req.method })
  res.status(500).json({ error: 'Internal server error' })
}
