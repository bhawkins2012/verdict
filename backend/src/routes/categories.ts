// Public catalog routes (docs/adr-generation-run.md D12). Everything comes from catalog/public.ts, which reads
// only published nodes, approved levers' snapshots, listed products and the published value copy.
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { browse, nodePage, search } from '../catalog/public'

export const categoriesRouter = Router()

// GET /api/categories: the visible taxonomy as a tree
categoriesRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await browse())
})

const qSchema = z.string().trim().max(100)

// GET /api/categories/search?q=: nodes first (published or "being prepared"), then listed products
categoriesRouter.get('/search', async (req: Request, res: Response) => {
  const q = qSchema.safeParse(req.query.q)
  if (!q.success) throw new AppError(400, 'q must be a string of at most 100 characters')
  res.json(await search(q.data))
})

// GET /api/categories/:slug?lever[<leverId>][min]=…: a navigation node (explainer and children) or a
// decision node (five lever filters and the product list)
categoriesRouter.get('/:slug', async (req: Request, res: Response) => {
  res.json(await nodePage(req.params.slug, req.query.lever))
})
