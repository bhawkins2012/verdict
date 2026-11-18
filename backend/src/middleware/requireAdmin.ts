import { Request, Response, NextFunction } from 'express'
import { UserRole } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from './errorHandler'

/**
 * After `authenticate`. The role is read from the database on every request, never from the token, so
 * revoking admin takes effect at once (docs/adr-levers.md D1).
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.userId) throw new AppError(401, 'Authentication required')
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } })
  if (user?.role !== UserRole.ADMIN) throw new AppError(403, 'Admin access required')
  next()
}
