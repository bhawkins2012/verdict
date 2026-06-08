import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { AppError } from '../middleware/errorHandler'
import { authenticate } from '../middleware/authenticate'

export const authRouter = Router()

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/i),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

function signTokens(userId: string) {
  const accessToken = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as jwt.SignOptions['expiresIn'] }
  )
  const refreshToken = jwt.sign(
    { sub: userId },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '30d') as jwt.SignOptions['expiresIn'] }
  )
  return { accessToken, refreshToken }
}

// POST /api/auth/register
authRouter.post('/register', async (req: Request, res: Response) => {
  const body = registerSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)

  const { email, username, password, displayName } = body.data

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] }
  })
  if (existing) throw new AppError(409, 'Email or username already taken')

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: { email, username, passwordHash, displayName },
    select: { id: true, email: true, username: true, displayName: true }
  })

  const { accessToken, refreshToken } = signTokens(user.id)
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }
  })

  res.status(201).json({ user, accessToken, refreshToken })
})

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  const body = loginSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, 'Invalid credentials')

  const user = await prisma.user.findUnique({ where: { email: body.data.email } })
  if (!user) throw new AppError(401, 'Invalid credentials')

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

  let payload: any
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!)
  } catch {
    throw new AppError(401, 'Invalid or expired refresh token')
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } })
  if (!stored || stored.expiresAt < new Date()) throw new AppError(401, 'Refresh token expired')

  // Rotate refresh token
  await prisma.refreshToken.delete({ where: { token: refreshToken } })
  const tokens = signTokens(payload.sub)
  await prisma.refreshToken.create({
    data: {
      userId: payload.sub,
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
      avatarUrl: true, createdAt: true, emailVerified: true,
      demographics: true,
    }
  })
  if (!user) throw new AppError(404, 'User not found')
  res.json(user)
})
