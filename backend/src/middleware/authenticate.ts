import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppError } from './errorHandler'

declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
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
