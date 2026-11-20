import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { Prisma, PriceTier } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/authenticate'
import { AppError } from '../middleware/errorHandler'
import { NodeKind } from '@prisma/client'
import { productLevers } from '../catalog/public'
import { publicProductWhere } from '../catalog/products'

export const productsRouter = Router()

const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
)

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional(),
  category: z.string().min(1).max(50),
  subcategory: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  priceTier: z.nativeEnum(PriceTier).optional(),
  attributes: z.record(jsonValueSchema).optional(),
  amazonAsin: z.string().optional(),
})

// GET /api/products — search / browse products
productsRouter.get('/', async (req: Request, res: Response) => {
  const { q, category, brand, page = '1', limit = '20' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(limit)

  // Discovered products appear only once approved (docs/adr-generation-run.md D2).
  const where: Prisma.ProductWhereInput = { AND: [publicProductWhere()] }
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
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, ...publicProductWhere() },
    include: {
      _count: { select: { reviewThreads: true, aggregatedReviews: true } },
      node: { select: { slug: true, name: true, publishedAt: true } },
    }
  })
  // Discovered products are public only once a publish lists them (docs/adr-generation-run.md D10).
  if (!product) {
    throw new AppError(404, 'Product not found')
  }
  // The five published levers of its node with this product's published values and evidence (ADR D12).
  const { node, ...rest } = product
  res.json({
    id: rest.id, name: rest.name, brand: rest.brand, category: rest.category, subcategory: rest.subcategory, description: rest.description,
    imageUrl: rest.imageUrl, websiteUrl: rest.websiteUrl, priceTier: rest.priceTier, attributes: rest.attributes,
    avgRatingInitial: rest.avgRatingInitial, avgRatingLongterm: rest.avgRatingLongterm, driftScoreAvg: rest.driftScoreAvg,
    totalReviewCount: rest.totalReviewCount, createdAt: rest.createdAt, _count: rest._count, isDryRun: rest.isDryRun,
    node: node && rest.listed && node.publishedAt ? { slug: node.slug, name: node.name } : null,
    levers: await productLevers(product.id),
  })
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

  // A product belongs to a decision node; an unknown one is a 400 that lists the valid ones (ADR Q10).
  const slug = body.data.category.trim().toLowerCase()
  const category = await prisma.taxonomyNode.findFirst({ where: { slug, kind: NodeKind.DECISION }, select: { id: true, slug: true } })
  if (!category) {
    const valid = await prisma.taxonomyNode.findMany({ where: { kind: NodeKind.DECISION }, orderBy: { slug: 'asc' }, select: { slug: true } })
    throw new AppError(400, `Unknown category "${body.data.category.slice(0, 50)}". Valid categories: ${valid.map((c) => c.slug).join(', ') || '(none yet)'}`, {
      validCategories: valid.map((c) => c.slug),
    })
  }

  const d = body.data
  const product = await prisma.product.create({
    data: {
      name: d.name, brand: d.brand, category: category.slug, nodeId: category.id, subcategory: d.subcategory,
      description: d.description, imageUrl: d.imageUrl, websiteUrl: d.websiteUrl, priceTier: d.priceTier,
      attributes: d.attributes, amazonAsin: d.amazonAsin, createdBy: req.userId,
    }
  })
  res.status(201).json(product)
})

// GET /api/products/categories/list — published decision nodes (kept for older clients; GET /api/categories
// is the tree).
productsRouter.get('/categories/list', async (_req: Request, res: Response) => {
  const nodes = await prisma.taxonomyNode.findMany({
    where: { kind: NodeKind.DECISION, publishedAt: { not: null } }, orderBy: { name: 'asc' },
    select: { slug: true, _count: { select: { products: { where: { listed: true } } } } },
  })
  res.json(nodes.map((n) => ({ name: n.slug, count: n._count.products })))
})
