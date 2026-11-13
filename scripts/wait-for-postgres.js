#!/usr/bin/env node
// Wait until Postgres answers a real query using the app's own DATABASE_URL: connect + auth + SELECT 1.
//
// A TCP check is not enough. With Docker's published ports, the host port accepts connections before
// Postgres is listening behind it (the image's first boot runs a socket-only temporary server, then
// restarts). This probe only succeeds once the server really speaks the Postgres protocol and accepts
// our credentials. No new dependencies: it uses the backend's Prisma client.
//
// Usage:  node scripts/wait-for-postgres.js [timeoutSeconds=90]
// DATABASE_URL comes from the environment, else backend/.env.
// Exit codes: 0 ready, 1 not ready before the timeout, 2 cannot run (missing deps / bad configuration).
const path = require('path')

const backendDir = path.join(__dirname, '..', 'backend')
const timeoutMs = Number(process.argv[2] || 90) * 1000
const PER_ATTEMPT_MS = 8000
const MAX_BACKOFF_MS = 5000

let PrismaClient
try {
  const fromBackend = (id) => require.resolve(id, { paths: [backendDir] })
  require(fromBackend('dotenv')).config({ path: path.join(backendDir, '.env') })
  ;({ PrismaClient } = require(fromBackend('@prisma/client')))
} catch (err) {
  console.error(`Cannot load the backend's dependencies (${err.code || err.message}). Run: bash .devcontainer/install-deps.sh`)
  process.exit(2)
}

// Describe the target without ever printing credentials.
function target() {
  try {
    const u = new URL(process.env.DATABASE_URL)
    return `${u.hostname}:${u.port || 5432}`
  } catch {
    return '(DATABASE_URL is missing or not a valid URL)'
  }
}

function shortReason(err) {
  const lines = String(err && err.message ? err.message : err).split('\n').map((l) => l.trim()).filter(Boolean)
  const useful = lines.filter((l) => /can't reach|authentication|denied|no answer|closed|reset|refused|error validating datasource|database string is invalid|P\d{4}/i.test(l))
  return (useful.length ? useful : lines.slice(-1))[0] || 'unknown error'
}

// Errors that retrying cannot fix.
const isConfigError = (err) => /Environment variable not found|Error validating datasource|database string is invalid|Error parsing connection string/i.test(String(err && err.message))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${(ms / 1000).toFixed(1)}s (the port accepted the connection but the server did not respond)`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function probeOnce(budgetMs) {
  const prisma = new PrismaClient({ log: [] })
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, Math.min(PER_ATTEMPT_MS, budgetMs))
  } finally {
    // Never let a stuck disconnect hold the process or overrun the caller's time budget.
    await Promise.race([prisma.$disconnect().catch(() => {}), sleep(300)])
  }
}

;(async () => {
  const start = Date.now()
  const deadline = start + timeoutMs
  let backoff = 500
  let lastErr = null

  for (let attempt = 1; ; attempt++) {
    const budget = deadline - Date.now()
    if (budget <= 0) break
    try {
      await probeOnce(budget)
      const secs = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`Postgres at ${target()} answered SELECT 1 (attempt ${attempt}, ${secs}s)`)
      process.exit(0)
    } catch (err) {
      lastErr = err
      if (isConfigError(err)) {
        console.error(`Postgres configuration error: ${shortReason(err)}. Check DATABASE_URL (backend/.env).`)
        process.exit(2)
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`Postgres at ${target()} not ready (attempt ${attempt}, ${elapsed}s): ${shortReason(err)}`)
    }
    const wait = Math.min(backoff, Math.max(0, deadline - Date.now()))
    if (wait <= 0) break
    await sleep(wait)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  console.error(`Timed out after ${timeoutMs / 1000}s waiting for Postgres at ${target()}: ${lastErr ? shortReason(lastErr) : 'no attempt completed'}`)
  process.exit(1)
})()
