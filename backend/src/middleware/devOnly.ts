// Development-only routes (nudge send-now and outbox, verification link). An allow-list, so staging, an
// unset NODE_ENV or a typo fail closed: these routes can re-send email, ignore the daily cap, or reveal
// a verification link.
import { NextFunction, Request, Response } from 'express'
import { AppError } from './errorHandler'

/** NODE_ENV is development or test (an allow-list: unset, staging or a typo are not). */
export function isDevEnvironment(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
}

export function devOnly(_req: Request, _res: Response, next: NextFunction): void {
  if (!isDevEnvironment()) throw new AppError(404, 'Not found')
  next()
}
