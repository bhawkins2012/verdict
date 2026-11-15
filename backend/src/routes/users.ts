import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AgeRange, IncomeBracket, EducationLevel } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { dueNudgesWhere, syncThreadNudges } from '../nudges/lifecycle'
import { enqueueAfterCommit } from '../nudges/runtime'
import { isValidTimeZone } from '../nudges/time'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { loadNudgeConfig } from '../nudges/config'
import { emailField, maskEmail } from '../auth/emailAddress'
import { claimAddressSlot, releaseSlot, takeEmailChangeAttempt } from '../auth/emailLimits'
import { renderEmailChangedEmail } from '../auth/emails'
import { ipLimiter, tooManyRequests } from '../auth/ipLimits'
import { afterResponse, sendAccountEmail, verificationEmailTask } from '../auth/mailer'
import { issueVerificationToken } from '../auth/verificationTokens'

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
  nudgePromptDismissedAt: true,
  emailNudgesFirstEnabledAt: true,
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

// POST /api/users/me/nudge-prompt/dismiss — the user declined the post-first-review email prompt.
// Records the first decline only; the prompt is never shown again. Changes no other setting, and
// nothing else (opting in or out on the profile) clears it.
usersRouter.post('/me/nudge-prompt/dismiss', authenticate, async (req: Request, res: Response) => {
  await prisma.user.updateMany({ where: { id: req.userId!, nudgePromptDismissedAt: null }, data: { nudgePromptDismissedAt: new Date() } })
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
    // The first opt-in is recorded once and never cleared (the opt-in prompt is never shown again).
    const firstEnabled = emailNudgesEnabled && !current.emailNudgesFirstEnabledAt ? { emailNudgesFirstEnabledAt: now } : {}

    const settings = await tx.user.update({
      where: { id: userId },
      data: { emailNudgesEnabled, timezone, nudgeSendHour, ...consent, ...firstEnabled },
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

const emailChangeSchema = z.object({ email: emailField, currentPassword: z.string().min(1).max(200) }).strict()
const emailChangeLimiter = ipLimiter()

// PUT /api/users/me/email { email, currentPassword } (docs/adr-email-verification.md D7).
// Needs the current password; at most 5 attempts per user per hour (right or wrong password). The new
// address starts unverified: outstanding links are superseded, a link goes to the new address and a
// notice to the old one. Email-reminder consent is kept (Q4); nudges stay in-app until verified.
usersRouter.put('/me/email', authenticate, emailChangeLimiter, async (req: Request, res: Response) => {
  const body = emailChangeSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)
  const userId = req.userId!
  const now = new Date()

  const attempt = await takeEmailChangeAttempt(prisma, userId, now)
  if (!attempt.allowed) return tooManyRequests(res, attempt.retryAfterSeconds, 'Too many email changes. Please try again later.')

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true, emailVerified: true } })
  if (!user) throw new AppError(404, 'User not found')
  if (!(await bcrypt.compare(body.data.currentPassword, user.passwordHash))) throw new AppError(403, 'Current password is incorrect')

  const email = body.data.email
  if (email === user.email) return res.json({ email, emailVerified: user.emailVerified, changed: false })
  // Q3: a plain 409 (exposure limited to a signed-in user who knows the account password, rate-limited).
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new AppError(409, 'That email address is already in use')

  const slot = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', email, now)
  if (!slot.allowed) {
    return tooManyRequests(res, slot.retryAfterSeconds, 'We recently sent a link to that address. Please try again later.')
  }
  let token
  try {
    token = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { email, emailVerified: false, emailVerifiedAt: null } })
      return issueVerificationToken(tx, userId, email, now) // also supersedes every older link
    })
  } catch (e) {
    await releaseSlot(prisma, slot.eventId)
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError(409, 'That email address is already in use')
    throw e
  }

  res.json({ email, emailVerified: false, changed: true })
  const oldEmail = user.email
  const changeId = token.id
  afterResponse(verificationEmailTask(token, email, slot.eventId))
  afterResponse(() => {
    const c = loadNudgeConfig()
    const message = renderEmailChangedEmail(
      { to: oldEmail, newAddressMasked: maskEmail(email), changeId },
      { fromEmail: c.fromEmail, postalAddress: c.postalAddress }
    )
    return sendAccountEmail('email-changed', message)
  })
})
