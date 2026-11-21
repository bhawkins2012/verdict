// Imported first by command-line scripts whose output is read by people: one Prisma client that logs errors
// only (lib/prisma.ts logs every query when NODE_ENV=development, which buries the script's own output).
import { PrismaClient } from '@prisma/client'

globalThis.__prisma ??= new PrismaClient({ log: ['error'] })
