import { execSync } from 'child_process'
import { TEST_DATABASE_URL } from './testEnv'

// Apply committed migrations to the test schema (creates it if missing).
export default async function globalSetup() {
  execSync('npx prisma migrate deploy', {
    cwd: __dirname + '/..',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  })
}
