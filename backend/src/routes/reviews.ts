import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { ReviewStage, ReviewSource } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { scheduleNudges } from '../jobs/nudgeScheduler'
import { computeThreadDrift } from '../services/driftService'
import { enrichReviewWithNLP } from '../services/mlClient'

export const reviewsRouter = Router()

const reviewSchema = z.object({
  productId: z.string(),
  stage: z.nativeEnum(ReviewStage),
  scoreOverall: z.number().int().min(1).max(10),
  scoreValue: z.number().int().min(1).max(10).optional(),
  scoreQuality: z.number().int().min(1).max(10).optional(),
  scoreLongevity: z.number().int().min(1).max(10).optional(),
  scoreExpectations: z.number().int().min(1).max(10).optional(),
  bodyText: z.string().max(5000).optional(),
  pros: z.array(z.string().max(200)).max(10).default([]),
  cons: z.array(z.string().max(200)).max(10).default([]),
  wouldStillBuy: z.boolean().optional(),
  wouldRecommend: z.boolean().optional(),
})

// GET /api/reviews/thread/:productId — get full thread for a product
reviewsRouter.get('/thread/:productId', authenticate, async (req: Request, res: Response) => {
  const thread = await prisma.reviewThread.findUnique({
    where: {
      userId_productId: { userId: req.userId!, productId: req.params.productId }
    },
    include: {
      product: { select: { id: true, name: true, brand: true, category: true, imageUrl: true } },
      reviews: { orderBy: { capturedAt: 'asc' } },
      nudges: { where: { status: 'PENDING' }, orderBy: { scheduledFor: 'asc' } },
    }
  })

  if (!thread) throw new AppError(404, 'No review thread found for this product')
  res.json(thread)
})

// GET /api/reviews/threads — get all threads for current user
reviewsRouter.get('/threads', authenticate, async (req: Request, res: Response) => {
  const threads = await prisma.reviewThread.findMany({
    where: { userId: req.userId },
    include: {
      product: { select: { id: true, name: true, brand: true, category: true, imageUrl: true, priceTier: true } },
      reviews: { orderBy: { capturedAt: 'desc' }, take: 1 }, // latest review
      nudges: { where: { status: 'PENDING' }, orderBy: { scheduledFor: 'asc' }, take: 1 },
      _count: { select: { reviews: true } }
    },
    orderBy: { updatedAt: 'desc' }
  })
  res.json(threads)
})

// POST /api/reviews — create a new review (and thread if needed)
reviewsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const body = reviewSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)

  const { productId, stage, ...reviewData } = body.data
  const userId = req.userId!

  // Verify product exists
  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product) throw new AppError(404, 'Product not found')

  // Upsert the thread
  let thread = await prisma.reviewThread.findUnique({
    where: { userId_productId: { userId, productId } },
    include: { reviews: true }
  })

  if (thread) {
    // Prevent duplicate stage reviews
    const hasStage = thread.reviews.some(r => r.stage === stage)
    if (hasStage) throw new AppError(409, `You already submitted a ${stage} review for this product`)
  }

  // NLP enrichment (non-blocking)
  let nlpData: any = {}
  if (reviewData.bodyText) {
    try {
      nlpData = await enrichReviewWithNLP(reviewData.bodyText)
    } catch {
      // NLP enrichment is best-effort
    }
  }

  const review = await prisma.$transaction(async (tx) => {
    // Upsert thread
    const updatedThread = await tx.reviewThread.upsert({
      where: { userId_productId: { userId, productId } },
      create: { userId, productId, stagesCompleted: [stage] },
      update: { stagesCompleted: { push: stage }, updatedAt: new Date() },
    })

    // Create review
    const newReview = await tx.review.create({
      data: {
        threadId: updatedThread.id,
        stage,
        source: ReviewSource.NATIVE,
        ...reviewData,
        ...nlpData,
      }
    })

    return newReview
  })

  // Compute drift and schedule next nudge (async)
  computeThreadDrift(thread?.id || review.threadId).catch(console.error)
  scheduleNudges(review.threadId, stage, userId).catch(console.error)

  res.status(201).json(review)
})

// PATCH /api/reviews/:id — edit a review (within 24h only)
reviewsRouter.patch('/:id', authenticate, async (req: Request, res: Response) => {
  const review = await prisma.review.findUnique({
    where: { id: req.params.id },
    include: { thread: true }
  })

  if (!review) throw new AppError(404, 'Review not found')
  if (review.thread.userId !== req.userId) throw new AppError(403, 'Not your review')

  const hoursSinceCaptured = (Date.now() - review.capturedAt.getTime()) / (1000 * 60 * 60)
  if (hoursSinceCaptured > 24) throw new AppError(403, 'Reviews can only be edited within 24 hours')

  const allowedFields = z.object({
    bodyText: z.string().max(5000).optional(),
    pros: z.array(z.string()).optional(),
    cons: z.array(z.string()).optional(),
    wouldStillBuy: z.boolean().optional(),
    wouldRecommend: z.boolean().optional(),
  })

  const body = allowedFields.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)

  const updated = await prisma.review.update({
    where: { id: req.params.id },
    data: body.data,
  })

  res.json(updated)
})

// GET /api/reviews/product/:productId/stats — aggregate stats for a product
reviewsRouter.get('/product/:productId/stats', async (req: Request, res: Response) => {
  const reviews = await prisma.review.findMany({
    where: { thread: { productId: req.params.productId } },
    select: {
      stage: true,
      scoreOverall: true,
      scoreValue: true,
      scoreQuality: true,
      scoreLongevity: true,
      capturedAt: true,
      wouldStillBuy: true,
      wouldRecommend: true,
    }
  })

  if (!reviews.length) throw new AppError(404, 'No reviews found for this product')

  // Compute survivorship curve: avg score per stage
  const byStage: Record<string, { scores: number[], count: number }> = {}
  const stageOrder = ['INITIAL', 'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS']

  for (const r of reviews) {
    if (!byStage[r.stage]) byStage[r.stage] = { scores: [], count: 0 }
    byStage[r.stage].scores.push(r.scoreOverall)
    byStage[r.stage].count++
  }

  const survivorshipCurve = stageOrder
    .filter(s => byStage[s])
    .map(stage => ({
      stage,
      avgScore: byStage[stage].scores.reduce((a, b) => a + b, 0) / byStage[stage].scores.length,
      count: byStage[stage].count,
    }))

  const wouldRecommendRate = reviews.filter(r => r.wouldRecommend).length / reviews.filter(r => r.wouldRecommend !== null).length
  const wouldStillBuyRate = reviews.filter(r => r.wouldStillBuy).length / reviews.filter(r => r.wouldStillBuy !== null).length

  res.json({
    totalReviews: reviews.length,
    survivorshipCurve,
    wouldRecommendRate: isNaN(wouldRecommendRate) ? null : Math.round(wouldRecommendRate * 100),
    wouldStillBuyRate: isNaN(wouldStillBuyRate) ? null : Math.round(wouldStillBuyRate * 100),
  })
})
