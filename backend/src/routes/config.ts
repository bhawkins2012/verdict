import { Router, Request, Response } from 'express'
import { stageConfig } from '../stages'

export const configRouter = Router()

// GET /api/config — public, read-only: stage order and labels, the nudge cadence and the email consent
// copy generated from it. The frontend derives its stage lists and the opt-in text from this.
configRouter.get('/', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300').json(stageConfig())
})
