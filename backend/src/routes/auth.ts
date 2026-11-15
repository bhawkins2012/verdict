import { Router, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { authenticate } from '../middleware/authenticate'
import { devOnly } from '../middleware/devOnly'
import { logger } from '../lib/logger'
import { dryRunOutbox } from '../nudges/providers'
import { emailField, maskEmail } from '../auth/emailAddress'
import { claimAddressSlot } from '../auth/emailLimits'
import { renderSignupAttemptEmail } from '../auth/emails'
import { ipLimiter, tooManyRequests } from '../auth/ipLimits'
import { accountEmailSettings, afterResponse, sendAccountEmail, verificationEmailTask } from '../auth/mailer'
import { consumeVerificationToken, issueVerificationToken } from '../auth/verificationTokens'

export const authRouter = Router()

const registerSchema = z.object({
  email: emailField,
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/i),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80).optional(),
})

const loginSchema = z.object({
  email: emailField,
  password: z.string(),
})

const BCRYPT_ROUNDS = 12
/**
 * A bcrypt hash (cost 12) of a password nobody uses. Login compares against it when the email is unknown,
 * so an unknown address takes as long as a wrong password (no account enumeration by timing).
 */
const DUMMY_PASSWORD_HASH = '$2a$12$WCkHyIdzticnuyVuE9TI7ebDTuIPpoHHWEBzavnHVCYVZOPp/GeB6'

/** Resend: at most one per minute and 5 per hour per user (on top of one email per address per hour). */
export const RESEND_COOLDOWN_MS = 60 * 1000
export const RESEND_PER_HOUR = 5

/** The same body for a new and an already-registered address (docs/adr-email-verification.md D3). */
export const REGISTER_ACCEPTED = { message: 'Check your email, then sign in.' } as const
const INVALID_LINK = 'This link is invalid or has expired.'

const registerLimiter = ipLimiter()
const verifyLimiter = ipLimiter()
const resendLimiter = ipLimiter()

/** "Someone tried to sign up with your address", at most once per address per hour. */
async function signupAttemptTask(email: string, now: Date): Promise<(() => Promise<unknown>) | null> {
  const slot = await claimAddressSlot(prisma, 'SIGNUP_ATTEMPT_EMAIL', email, now)
  if (!slot.allowed) return null
  return () => {
    const settings = accountEmailSettings()
    const message = renderSignupAttemptEmail({ to: email, loginUrl: `${settings.frontendUrl}/login`, eventId: slot.eventId }, settings)
    return sendAccountEmail('signup-attempt', message, slot.eventId)
  }
}

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
const onUsername = (e: Prisma.PrismaClientKnownRequestError) => JSON.stringify(e.meta?.target ?? '').includes('username')

function signTokens(userId: string) {
  const accessToken = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as jwt.SignOptions['expiresIn'], jwtid: randomUUID() }
  )
  const refreshToken = jwt.sign(
    { sub: userId },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as jwt.SignOptions['expiresIn'], jwtid: randomUUID() }
  )
  return { accessToken, refreshToken }
}

// POST /api/auth/register: the same 202 for a new and an already-registered address, and the same work
// (password hash, one email after the response) on both paths. No tokens: the user signs in afterwards.
authRouter.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const body = registerSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)
  const { email, username, password, displayName } = body.data

  // Usernames are public handles, so a taken one may say so. Checked first, so the answer never depends
  // on whether the email is registered.
  if (await prisma.user.findUnique({ where: { username }, select: { id: true } })) {
    throw new AppError(409, 'Username already taken')
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const now = new Date()
  let task: (() => Promise<unknown>) | null
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    task = await signupAttemptTask(email, now)
  } else {
    try {
      const slot = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', email, now)
      const token = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email, username, passwordHash, displayName }, select: { id: true } })
        return issueVerificationToken(tx, user.id, email, now)
      })
      task = slot.allowed ? verificationEmailTask(token, email, slot.eventId) : null
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
      if (onUsername(e)) throw new AppError(409, 'Username already taken')
      task = await signupAttemptTask(email, now) // the address was registered concurrently
    }
  }

  res.status(202).json(REGISTER_ACCEPTED)
  if (task) afterResponse(task)
})

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  const body = loginSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, 'Invalid credentials')

  const user = await prisma.user.findUnique({ where: { email: body.data.email } })
  if (!user) {
    await bcrypt.compare(body.data.password, DUMMY_PASSWORD_HASH) // same work as a wrong password
    throw new AppError(401, 'Invalid credentials')
  }

  const valid = await bcrypt.compare(body.data.password, user.passwordHash)
  if (!valid) throw new AppError(401, 'Invalid credentials')

  const { accessToken, refreshToken } = signTokens(user.id)
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  })

  res.json({
    user: { id: user.id, email: user.email, username: user.username, displayName: user.displayName },
    accessToken,
    refreshToken,
  })
})

// POST /api/auth/refresh
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body
  if (!refreshToken) throw new AppError(401, 'Refresh token required')

  let userId: string
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!)
    if (typeof payload === 'string' || !payload.sub) throw new Error('Malformed refresh token')
    userId = payload.sub
  } catch {
    throw new AppError(401, 'Invalid or expired refresh token')
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } })
  if (!stored || stored.expiresAt < new Date()) throw new AppError(401, 'Refresh token expired')

  // Rotate: claim the old token atomically so a concurrent or repeated use gets 401, not a 500
  const { count } = await prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
  if (count === 0) throw new AppError(401, 'Refresh token already used')

  const tokens = signTokens(userId)
  await prisma.refreshToken.create({
    data: {
      userId,
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  })

  res.json(tokens)
})

// POST /api/auth/logout
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  const { refreshToken } = req.body
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
  }
  res.json({ success: true })
})

// GET /api/auth/me
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, email: true, username: true, displayName: true,
      avatarUrl: true, createdAt: true, emailVerified: true, emailVerifiedAt: true,
      demographics: true,
    }
  })
  if (!user) throw new AppError(404, 'User not found')
  // When the newest link for the current address was issued (the banner shows it).
  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id, email: user.email },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  res.json({ ...user, emailVerificationSentAt: latest?.createdAt ?? null })
})

// POST /api/auth/verify-email { id, token }: no login needed (the link may be opened on another device).
// Every failure gets the same answer; the reason is logged.
authRouter.post('/verify-email', verifyLimiter, async (req: Request, res: Response) => {
  const { id, token } = (req.body ?? {}) as { id?: unknown; token?: unknown }
  const result = await consumeVerificationToken(prisma, id, token, new Date())
  if (!result.ok) {
    logger.info('Email verification failed', { reason: result.reason, tokenId: typeof id === 'string' ? id.slice(0, 64) : undefined })
    throw new AppError(400, INVALID_LINK)
  }
  logger.info('Email verified', { userId: result.userId })
  res.json({ verified: true })
})

// POST /api/auth/verification/resend: a new link for your own address (the body takes no address).
authRouter.post('/verification/resend', authenticate, resendLimiter, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { id: true, email: true, emailVerified: true } })
  if (!user) throw new AppError(404, 'User not found')
  if (user.emailVerified) return res.json({ alreadyVerified: true })

  const now = new Date()
  const recent = await prisma.emailVerificationToken.findMany({
    where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  const wait = (until: number) => Math.max(1, Math.ceil((until - now.getTime()) / 1000))
  if (recent.length > 0 && now.getTime() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return tooManyRequests(res, wait(recent[0].createdAt.getTime() + RESEND_COOLDOWN_MS), 'Please wait a minute before requesting another link.')
  }
  if (recent.length >= RESEND_PER_HOUR) {
    return tooManyRequests(res, wait(recent[RESEND_PER_HOUR - 1].createdAt.getTime() + 60 * 60 * 1000), 'Too many links requested. Please try again later.')
  }
  // One verification email per address per hour; checked before issuing, so the current link stays valid.
  const slot = await claimAddressSlot(prisma, 'VERIFICATION_EMAIL', user.email, now)
  if (!slot.allowed) {
    return tooManyRequests(res, slot.retryAfterSeconds, 'We recently sent a link to this address. Please check your inbox or try again later.')
  }
  const token = await prisma.$transaction((tx) => issueVerificationToken(tx, user.id, user.email, now))
  res.status(202).json({ sentTo: maskEmail(user.email), sentAt: now })
  afterResponse(verificationEmailTask(token, user.email, slot.eventId))
})

// GET /api/auth/dev/verification-link: your newest verification link from the dry-run outbox
// (development and test only; the database stores only hashes, so the outbox is the only copy).
authRouter.get('/dev/verification-link', devOnly, authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { email: true } })
  const message = dryRunOutbox().find((m) => m.to === user.email && m.idempotencyKey.startsWith('verify/'))
  const link = message?.text.match(/https?:\/\/\S+\/verify-email#\S+/)?.[0]
  if (!link) throw new AppError(404, 'No verification link in the dry-run outbox for your address')
  res.json({ link, sentAt: message?.at })
})
