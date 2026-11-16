#!/usr/bin/env node
// Is the generated Prisma client up to date with backend/prisma/schema.prisma?
//
//   node scripts/prisma-client-status.js            (from anywhere)
//
// `prisma generate` copies the schema it generated from to node_modules/.prisma/client/schema.prisma.
// If that copy differs from backend/prisma/schema.prisma, the client is stale: queries using new models
// or fields fail at runtime ("Unknown argument ...", "Cannot read properties of undefined"), even though
// `prisma migrate deploy` succeeded. Fix: cd backend && npx prisma generate
//
// Prints one JSON line and exits 0 (current), 1 (stale), 2 (no generated client), 3 (no schema file).
// No dependencies, so it works before `npm install` too.
const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..', 'backend')

/** Compare a schema file with the generated client's copy. Whitespace-only differences are ignored. */
function prismaClientStatus(schemaPath = path.join(BACKEND, 'prisma', 'schema.prisma'), generatedPath = path.join(BACKEND, 'node_modules', '.prisma', 'client', 'schema.prisma')) {
  if (!fs.existsSync(schemaPath)) return { status: 'no-schema', schemaPath }
  if (!fs.existsSync(generatedPath)) return { status: 'missing', generatedPath }
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
  const same = normalize(fs.readFileSync(schemaPath, 'utf8')) === normalize(fs.readFileSync(generatedPath, 'utf8'))
  return { status: same ? 'current' : 'stale', schemaPath, generatedPath }
}

const EXIT = { current: 0, stale: 1, missing: 2, 'no-schema': 3 }

if (require.main === module) {
  const result = prismaClientStatus(process.argv[2], process.argv[3])
  console.log(JSON.stringify(result))
  process.exit(EXIT[result.status])
}

module.exports = { prismaClientStatus, EXIT }
