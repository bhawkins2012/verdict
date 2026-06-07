import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AgeRange, IncomeBracket, EducationLevel } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'

export const usersRouter = Router()

const demographicsSchema = z.object({
  ageRange: z.nativeEnum(AgeRange).optional(),
  genderIdentity: z.string().max(50).optional(),
  region: z.string().max(20).optional(),
  incomeBracket: z.nativeEnum(IncomeBracket).optional(),
  lifestyleTags: z.array(z.string().max(50)).max(20).optional(),
  householdSize: z.number().int().min(1).max(20).optional(),
  hasChildren: z.boolean().optional(),
  educationLevel: z.nativeEnum(EducationLevel).optional(),
})

// GET /api/users/me/stats
usersRouter.get('/me/stats', authenticate, async (req: Request, res: Response) => {
  const userId = req.userId!

  const [threadCount, reviewCount, pendingNudges] = await Promise.all([
    prisma.reviewThread.count({ where: { userId } }),
    prisma.review.count({ where: { thread: { userId } } }),
    prisma.nudge.count({ where: { userId, status: 'PENDING' } }),
  ])

  // Avg drift across all threads
  const threads = await prisma.reviewThread.findMany({
    where: { userId, driftScore: { not: null } },
    select: { driftScore: true }
  })
  const avgDrift = threads.length
    ? threads.reduce((sum, t) => sum + (t.driftScore || 0), 0) / threads.length
    : null

  res.json({ threadCount, reviewCount, pendingNudges, avgDrift })
})

// PUT /api/users/me/demographics
usersRouter.put('/me/demographics', authenticate, async (req: Request, res: Response) => {
  const body = demographicsSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)

  const demographics = await prisma.userDemographics.upsert({
    where: { userId: req.userId },
    create: { userId: req.userId!, ...body.data },
    update: body.data,
  })
  res.json(demographics)
})

// GET /api/users/me/activity — review activity feed
usersRouter.get('/me/activity', authenticate, async (req: Request, res: Response) => {
  const threads = await prisma.reviewThread.findMany({
    where: { userId: req.userId },
    include: {
      product: { select: { id: true, name: true, brand: true, imageUrl: true, category: true } },
      reviews: { orderBy: { capturedAt: 'desc' }, take: 1 },
      _count: { select: { reviews: true } }
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
  res.json(threads)
})
