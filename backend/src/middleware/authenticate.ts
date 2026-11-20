import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError } from './errorHandler'

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Authentication required')
  }

  const token = authHeader.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string }
    req.userId = payload.sub
    next()
  } catch {
    throw new AppError(401, 'Invalid or expired token')
  }
}

/**
 * For public routes whose answer depends on who asks: sets `req.userId` from a valid bearer token and
 * otherwise carries on anonymously (never 401, so a public page never starts the refresh flow).
 */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET!) as { sub: string }
      req.userId = payload.sub
    } catch {
      // An expired or bad token reads as anonymous here.
    }
  }
  next()
}
