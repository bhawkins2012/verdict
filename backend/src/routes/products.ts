import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { PriceTier } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'

export const productsRouter = Router()

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional(),
  category: z.string().min(1).max(50),
  subcategory: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  priceTier: z.nativeEnum(PriceTier).optional(),
  attributes: z.record(z.unknown()).optional(),
  amazonAsin: z.string().optional(),
})

// GET /api/products — search / browse products
productsRouter.get('/', async (req: Request, res: Response) => {
  const { q, category, brand, page = '1', limit = '20' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(limit)

  const where: any = {}
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { brand: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ]
  }
  if (category) where.category = { equals: category, mode: 'insensitive' }
  if (brand) where.brand = { equals: brand, mode: 'insensitive' }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: [{ totalReviewCount: 'desc' }, { name: 'asc' }],
      select: {
        id: true, name: true, brand: true, category: true, subcategory: true,
        imageUrl: true, priceTier: true, avgRatingInitial: true,
        avgRatingLongterm: true, driftScoreAvg: true, totalReviewCount: true,
      }
    }),
    prisma.product.count({ where })
  ])

  res.json({
    products,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
  })
})

// GET /api/products/:id
productsRouter.get('/:id', async (req: Request, res: Response) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { reviewThreads: true, aggregatedReviews: true } }
    }
  })
  if (!product) throw new AppError(404, 'Product not found')
  res.json(product)
})

// POST /api/products — add a new product (authenticated)
productsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const body = createProductSchema.safeParse(req.body)
  if (!body.success) throw new AppError(400, body.error.errors[0].message)

  // Check for duplicate by Amazon ASIN if provided
  if (body.data.amazonAsin) {
    const existing = await prisma.product.findUnique({ where: { amazonAsin: body.data.amazonAsin } })
    if (existing) throw new AppError(409, 'A product with this Amazon ASIN already exists')
  }

  const product = await prisma.product.create({
    data: { ...body.data, createdBy: req.userId }
  })
  res.status(201).json(product)
})

// GET /api/products/categories/list — list all categories
productsRouter.get('/categories/list', async (_req: Request, res: Response) => {
  const categories = await prisma.product.groupBy({
    by: ['category'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } }
  })
  res.json(categories.map(c => ({ name: c.category, count: c._count.id })))
})
