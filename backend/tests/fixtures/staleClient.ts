// Preload for tests/prismaClientGuard.test.ts: makes the real generated client look like one generated
// before email verification (no EmailRateEvent model), as after `git pull` without `prisma generate`.
import { Prisma } from '@prisma/client'

const models = Prisma.dmmf.datamodel.models as unknown as { name: string }[]
const i = models.findIndex((m) => m.name === 'EmailRateEvent')
if (i >= 0) models.splice(i, 1)
