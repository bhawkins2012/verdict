import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AgeRange, IncomeBracket, EducationLevel } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { dueNudgesWhere, syncThreadNudges } from '../nudges/lifecycle'
import { enqueueAfterCommit } from '../nudges/runtime'
import { isValidTimeZone } from '../nudges/time'

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
    prisma.nudge.count({ where: dueNudgesWhere(userId, new Date()) }), // same rule as GET /api/nudges
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

// ── Nudge notification settings (docs/adr-nudges.md D5) ──────────────────────────────────────────

const notificationSettingsSelect = {
  emailNudgesEnabled: true,
  emailNudgesConsentAt: true,
  timezone: true,
  nudgeSendHour: true,
  emailVerified: true,
} as const

const notificationSettingsSchema = z
  .object({
    emailNudgesEnabled: z.boolean().optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, 'timezone must be an IANA time zone, e.g. "Europe/Berlin"').optional(),
    nudgeSendHour: z.number().int().min(0).max(23).optional(),
  })
  .strict()

// GET /api/users/me/notification-settings
usersRouter.get('/me/notification-settings', authenticate, async (req: Request, res: Response) => {
  const settings = await prisma.user.findUnique({ where: { id: req.userId! }, select: notificationSettingsSelect })
  if (!settings) throw new AppError(404, 'User not found')
  res.json(settings)
})

// PUT /api/users/me/notification-settings — opt in/out of email, time zone, preferred send hour
usersRouter.put('/me/notification-settings', authenticate, async (req: Request, res: Response) => {
  const body = notificationSettingsSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)
  const userId = req.userId!
  const { emailNudgesEnabled, timezone, nudgeSendHour } = body.data
  const now = new Date()

  const { settings, enqueue } = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({ where: { id: userId }, select: notificationSettingsSelect })
    if (!current) throw new AppError(404, 'User not found')

    // Record when consent was given; clear it on opt-out.
    const consent =
      emailNudgesEnabled === undefined || emailNudgesEnabled === current.emailNudgesEnabled
        ? {}
        : { emailNudgesConsentAt: emailNudgesEnabled ? now : null }

    const settings = await tx.user.update({
      where: { id: userId },
      data: { emailNudgesEnabled, timezone, nudgeSendHour, ...consent },
      select: notificationSettingsSelect,
    })

    // A new time zone or send hour moves every pending nudge's send time: re-plan the user's threads.
    const enqueue: string[] = []
    if ((timezone !== undefined && timezone !== current.timezone) || (nudgeSendHour !== undefined && nudgeSendHour !== current.nudgeSendHour)) {
      const threads = await tx.reviewThread.findMany({ where: { userId }, select: { id: true } })
      for (const t of threads) enqueue.push(...(await syncThreadNudges(tx, t.id, now, { retime: true })))
    }
    return { settings, enqueue }
  })

  enqueueAfterCommit(enqueue)
  res.json(settings)
})
