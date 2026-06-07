import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'

export const nudgesRouter = Router()

// GET /api/nudges — get pending nudges for current user
nudgesRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const nudges = await prisma.nudge.findMany({
    where: { userId: req.userId, status: 'PENDING' },
    include: {
      thread: {
        include: {
          product: { select: { id: true, name: true, brand: true, imageUrl: true } },
          reviews: { orderBy: { capturedAt: 'asc' }, take: 1 },
        }
      }
    },
    orderBy: { scheduledFor: 'asc' }
  })
  res.json(nudges)
})

// POST /api/nudges/:id/skip — dismiss a nudge
nudgesRouter.post('/:id/skip', authenticate, async (req: Request, res: Response) => {
  const nudge = await prisma.nudge.findUnique({ where: { id: req.params.id } })
  if (!nudge) throw new AppError(404, 'Nudge not found')
  if (nudge.userId !== req.userId) throw new AppError(403, 'Not your nudge')

  await prisma.nudge.update({
    where: { id: req.params.id },
    data: { status: 'SKIPPED' }
  })
  res.json({ success: true })
})
