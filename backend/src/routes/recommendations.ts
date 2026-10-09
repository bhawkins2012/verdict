import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { getRecommendations } from '../services/mlClient'

export const recommendationsRouter = Router()

// GET /api/recommendations — personalized recommendations for current user
recommendationsRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const userId = req.userId!
  const limit = parseInt(req.query.limit as string || '10')
  const category = req.query.category as string | undefined

  // Fetch user with demographics and review history
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { demographics: true }
  })
  if (!user) throw new AppError(404, 'User not found')

  // Get products the user has already reviewed — exclude these
  const reviewedProductIds = await prisma.reviewThread.findMany({
    where: { userId },
    select: { productId: true }
  })
  const excludeIds = reviewedProductIds.map(t => t.productId)

  // Build user feature vector for ML service
  const userFeatures = {
    userId,
    demographics: user.demographics ? {
      ageRange: user.demographics.ageRange,
      genderIdentity: user.demographics.genderIdentity,
      region: user.demographics.region,
      incomeBracket: user.demographics.incomeBracket,
      lifestyleTags: user.demographics.lifestyleTags,
      householdSize: user.demographics.householdSize,
      hasChildren: user.demographics.hasChildren,
    } : null,
    excludeProductIds: excludeIds,
    category,
    limit,
  }

  try {
    // Call ML service
    const mlRecommendations = await getRecommendations(userFeatures)

    // Hydrate with full product data
    const productIds = mlRecommendations.map((r) => r.productId)
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true, name: true, brand: true, category: true, imageUrl: true,
        priceTier: true, avgRatingInitial: true, avgRatingLongterm: true,
        driftScoreAvg: true, totalReviewCount: true,
      }
    })

    // Merge ML scores with product data, preserve order
    const enriched = mlRecommendations
      .map((rec) => ({
        ...rec,
        product: products.find(p => p.id === rec.productId),
      }))
      .filter((r) => r.product)

    res.json({ recommendations: enriched, userId })
  } catch (err) {
    logger.warn('ML recommendations failed; serving popularity fallback', { err })
    // Fallback: return top-rated products by avg long-term score
    const fallback = await prisma.product.findMany({
      where: {
        id: { notIn: excludeIds },
        ...(category ? { category } : {}),
        avgRatingLongterm: { not: null },
        totalReviewCount: { gte: 1 },
      },
      orderBy: [{ avgRatingLongterm: 'desc' }, { totalReviewCount: 'desc' }],
      take: limit,
      select: {
        id: true, name: true, brand: true, category: true, imageUrl: true,
        priceTier: true, avgRatingInitial: true, avgRatingLongterm: true,
        driftScoreAvg: true, totalReviewCount: true,
      }
    })

    res.json({
      recommendations: fallback.map(p => ({
        productId: p.id,
        score: p.avgRatingLongterm,
        reason: 'Highly rated long-term by similar users',
        product: p,
        isFallback: true,
      })),
      userId,
      isFallback: true,
    })
  }
})

// GET /api/recommendations/trending — trending products (no auth needed)
recommendationsRouter.get('/trending', async (req: Request, res: Response) => {
  const category = req.query.category as string | undefined
  const products = await prisma.product.findMany({
    where: {
      ...(category ? { category } : {}),
      totalReviewCount: { gte: 1 },
    },
    orderBy: [{ totalReviewCount: 'desc' }, { avgRatingLongterm: 'desc' }],
    take: 12,
    select: {
      id: true, name: true, brand: true, category: true, imageUrl: true,
      priceTier: true, avgRatingInitial: true, avgRatingLongterm: true,
      driftScoreAvg: true, totalReviewCount: true,
    }
  })
  res.json(products)
})
