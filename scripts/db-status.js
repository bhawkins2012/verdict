#!/usr/bin/env node
// Print database/seed status as JSON using the backend's Prisma client. Exits 1 if the DB is unreachable.
// Loads backend/.env itself (the Prisma client, unlike the CLI, does not). Works from any directory.
const path = require('path')

const backendDir = path.join(__dirname, '..', 'backend')
const resolveFromBackend = (id) => require.resolve(id, { paths: [backendDir] })

require(resolveFromBackend('dotenv')).config({ path: path.join(backendDir, '.env') })
const clientPath = resolveFromBackend('@prisma/client')
const { PrismaClient } = require(clientPath)

const prisma = new PrismaClient({ log: [] })

;(async () => {
  const [{ history, usersTable }] = await prisma.$queryRaw`
    SELECT to_regclass('_prisma_migrations') IS NOT NULL AS history,
           to_regclass('users') IS NOT NULL AS "usersTable"`
  let users = 0
  let hasDemoUser = false
  if (usersTable) {
    users = await prisma.user.count()
    hasDemoUser = Boolean(await prisma.user.findUnique({ where: { email: 'alice@example.com' }, select: { id: true } }))
  }
  // migrationHistory=false with usersTable=true means the schema was created with `prisma db push`.
  console.log(JSON.stringify({ migrationHistory: history, usersTable, users, hasDemoUser }))
})()
  .catch((err) => {
    const lines = String(err.message || err).split('\n').map((l) => l.trim()).filter(Boolean)
    const useful = lines.filter((l) => /error|not found|can't reach|authentication|denied|P\d{4}/i.test(l))
    console.error((useful.length ? useful : lines).slice(0, 2).join(' '))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
