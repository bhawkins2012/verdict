import express, { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { devOnly } from '../middleware/devOnly'
import { loadNudgeConfig } from '../nudges/config'
import { dueNudgesWhere, NudgeActionError, skipNudge, snoozeNudge } from '../nudges/lifecycle'
import { dryRunOutbox } from '../nudges/providers'
import { enqueueAfterCommit, processNudgeNow } from '../nudges/runtime'
import { verifyUnsubscribeToken } from '../nudges/unsubscribe'

export const nudgesRouter = Router()

const nudgeInclude = {
  thread: {
    include: {
      product: { select: { id: true, name: true, brand: true, imageUrl: true } },
      reviews: { orderBy: { capturedAt: 'asc' as const }, take: 1 },
    },
  },
}

function rethrow(err: unknown): never {
  if (err instanceof NudgeActionError) throw new AppError(err.status, err.message)
  throw err
}

// GET /api/nudges — check-ins that are due now (the one source for the nav badge, banner and list)
nudgesRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const nudges = await prisma.nudge.findMany({
    where: dueNudgesWhere(req.userId!, new Date()),
    include: nudgeInclude,
    orderBy: { scheduledFor: 'asc' },
  })
  res.json(nudges)
})

// POST /api/nudges/:id/skip — never nudge for this stage; plan the next one
nudgesRouter.post('/:id/skip', authenticate, async (req: Request, res: Response) => {
  const ids = await prisma.$transaction((tx) => skipNudge(tx, req.params.id, req.userId!, new Date())).catch(rethrow)
  enqueueAfterCommit(ids)
  res.json({ success: true })
})

const snoozeSchema = z.object({ days: z.union([z.literal(7), z.literal(30)]) })

// POST /api/nudges/:id/snooze { days: 7 | 30 } — hide it and remind again later (max 3 times)
nudgesRouter.post('/:id/snooze', authenticate, async (req: Request, res: Response) => {
  const body = snoozeSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, 'days must be 7 or 30')
  const ids = await prisma
    .$transaction((tx) => snoozeNudge(tx, req.params.id, req.userId!, body.data.days, new Date()))
    .catch(rethrow)
  enqueueAfterCommit(ids)
  const nudge = await prisma.nudge.findUniqueOrThrow({ where: { id: req.params.id }, select: { snoozedUntil: true, snoozeCount: true } })
  res.json(nudge)
})

// ── Unsubscribe (no login; the signed token is the authorisation) ─────────────────────────────────
// GET shows a confirmation page and does NOT unsubscribe (mail scanners prefetch links). POST does,
// both from that page's button and from mail clients' one-click (RFC 8058) List-Unsubscribe-Post.

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(res: Response, status: number, title: string, body: string) {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`)
}

function validUnsubscribe(req: Request): string | null {
  const { u, t } = req.query
  const secret = loadNudgeConfig().unsubscribeSecret
  return verifyUnsubscribeToken(secret, u, t) && typeof u === 'string' ? u : null
}

const INVALID_LINK = '<p>This unsubscribe link is invalid or incomplete. Use the link from the most recent email, or turn off reminders in your profile.</p>'

nudgesRouter.get('/unsubscribe', (req: Request, res: Response) => {
  if (!validUnsubscribe(req)) return page(res, 400, 'Invalid link', INVALID_LINK)
  const action = escapeHtml(req.originalUrl)
  page(
    res,
    200,
    'Stop review reminder emails?',
    `<p>You will no longer get check-in emails from Verdict. Check-ins still appear when you sign in.</p>` +
      `<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`
  )
})

nudgesRouter.post('/unsubscribe', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const userId = validUnsubscribe(req)
  if (!userId) return page(res, 400, 'Invalid link', INVALID_LINK)
  await prisma.user.updateMany({ where: { id: userId }, data: { emailNudgesEnabled: false, emailNudgesConsentAt: null } })
  page(res, 200, "You're unsubscribed", '<p>You will no longer get review reminder emails. You can turn them back on in your profile.</p>')
})

// ── Development only (devOnly: NODE_ENV allow-list, see middleware/devOnly.ts) ────────────────────────

// POST /api/nudges/:id/send-now — make one of your nudges due now and run the real send path inline
// (ignores the daily cap and the send hour). With the default dry-run provider nothing leaves the machine.
nudgesRouter.post('/:id/send-now', devOnly, authenticate, async (req: Request, res: Response) => {
  const nudge = await prisma.nudge.findUnique({ where: { id: req.params.id } })
  if (!nudge) throw new AppError(404, 'Nudge not found')
  if (nudge.userId !== req.userId) throw new AppError(403, 'Not your nudge')
  if (['COMPLETED', 'SKIPPED', 'CANCELLED', 'SENDING'].includes(nudge.status)) {
    throw new AppError(409, `A ${nudge.status.toLowerCase()} nudge cannot be sent`)
  }
  const now = new Date()
  await prisma.nudge.update({
    where: { id: nudge.id },
    data: {
      status: 'PENDING', sendAt: now, claimedAt: null, snoozedUntil: null,
      scheduledFor: nudge.scheduledFor > now ? now : nudge.scheduledFor,
    },
  })
  const outcome = await processNudgeNow(nudge.id, { ignoreCapAndHour: true })
  const after = await prisma.nudge.findUniqueOrThrow({ where: { id: nudge.id } })
  res.json({ outcome, nudge: after })
})

// GET /api/nudges/dev/outbox — what the dry-run provider "sent", newest first (your own messages only)
nudgesRouter.get('/dev/outbox', devOnly, authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { email: true } })
  res.json(dryRunOutbox().filter((m) => m.to === user.email))
})
