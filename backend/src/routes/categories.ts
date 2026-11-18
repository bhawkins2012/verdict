// Public category routes (docs/adr-levers.md D6). Levers come only from publicLevers() (approved and
// published); categories without published levers are hidden from browse.
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { browseCategories, categoryPage, searchCategories } from '../levers/catalog'

export const categoriesRouter = Router()

// GET /api/categories: browse (published categories only)
categoriesRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await browseCategories())
})

// GET /api/categories/search?q=: categories matching a search, published or "being prepared"
categoriesRouter.get('/search', async (req: Request, res: Response) => {
  const q = z.string().trim().max(100).safeParse(req.query.q)
  if (!q.success) throw new AppError(400, 'q must be a string of at most 100 characters')
  res.json(await searchCategories(q.data))
})

// GET /api/categories/:slug?lever[<leverId>][min]=…: the category page with lever filters
categoriesRouter.get('/:slug', async (req: Request, res: Response) => {
  res.json(await categoryPage(req.params.slug, req.query.lever))
})
