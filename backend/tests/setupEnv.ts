import { TEST_DATABASE_URL } from './testEnv'

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = TEST_DATABASE_URL
process.env.JWT_SECRET = 'test-access-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long'
process.env.JWT_EXPIRES_IN = '15m'
process.env.JWT_REFRESH_EXPIRES_IN = '30d'
process.env.ML_SERVICE_URL = 'http://ml.test'
process.env.LOG_LEVEL = 'error'
// The per-IP limit on account-email routes is 10 per 15 min by default; the suite registers many users.
process.env.VERIFY_RATE_LIMIT_MAX = '10000'
// Tests must not depend on where they run: inside a GitHub Codespace these would turn every emailed link
// into the forwarded https address (src/lib/frontendUrl.ts). Tests that need them set them explicitly.
for (const k of ['CODESPACE_NAME', 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'FRONTEND_PORT', 'FRONTEND_URL']) delete process.env[k]
// Generation runs: dry run, and an empty key so a real ANTHROPIC_API_KEY in backend/.env is never loaded
// (dotenv does not override variables that are already set). Live-mode tests inject a fake model and a
// fake fetcher; the real model and the network fetcher refuse to start under NODE_ENV=test.
process.env.GENERATION_MODE = 'dry_run'
process.env.ANTHROPIC_API_KEY = ''
