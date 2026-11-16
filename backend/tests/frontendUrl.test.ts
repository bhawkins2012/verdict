import { spawnSync } from 'child_process'
import path from 'path'
import type { Express } from 'express'
import request from 'supertest'
import { corsOrigins, frontendUrlStartupMessages, isLocalhostUrl, resolveFrontendUrl } from '../src/lib/frontendUrl'
import { loadNudgeConfig } from '../src/nudges/config'

const CODESPACE = { CODESPACE_NAME: 'fuzzy-robot-x7g', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }

describe('resolveFrontendUrl', () => {
  it('outside a Codespace: FRONTEND_URL, else http://localhost:5173', () => {
    expect(resolveFrontendUrl({})).toEqual({ url: 'http://localhost:5173', source: 'default', port: 5173, isLocalhost: true })
    expect(resolveFrontendUrl({ FRONTEND_URL: 'https://verdict.example.com/' })).toMatchObject({ url: 'https://verdict.example.com', source: 'FRONTEND_URL', isLocalhost: false })
    expect(resolveFrontendUrl({ FRONTEND_URL: 'http://localhost:5173' })).toMatchObject({ url: 'http://localhost:5173', source: 'FRONTEND_URL', isLocalhost: true })
  })

  it('in a Codespace with FRONTEND_URL unset or on localhost: the forwarded https address', () => {
    const derived = { url: 'https://fuzzy-robot-x7g-5173.app.github.dev', source: 'codespaces', port: 5173, isLocalhost: false }
    expect(resolveFrontendUrl({ ...CODESPACE })).toEqual(derived)
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_URL: 'http://localhost:5173' })).toEqual(derived)
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_URL: 'http://127.0.0.1:5173/' })).toEqual(derived)
  })

  it('uses the configured frontend port: FRONTEND_PORT, else the port in a localhost FRONTEND_URL', () => {
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_PORT: '4000' }).url).toBe('https://fuzzy-robot-x7g-4000.app.github.dev')
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_URL: 'http://localhost:5174' }).url).toBe('https://fuzzy-robot-x7g-5174.app.github.dev')
    expect(resolveFrontendUrl({ FRONTEND_PORT: '4000' }).url).toBe('http://localhost:4000')
    // A localhost FRONTEND_URL follows FRONTEND_PORT, so local links match where Vite listens.
    expect(resolveFrontendUrl({ FRONTEND_URL: 'http://localhost:5173', FRONTEND_PORT: '5199' }).url).toBe('http://localhost:5199')
    expect(resolveFrontendUrl({ FRONTEND_URL: 'https://verdict.example.com', FRONTEND_PORT: '5199' }).url).toBe('https://verdict.example.com')
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_PORT: 'nope' }).port).toBe(5173)
  })

  it('in a Codespace, an explicit non-localhost FRONTEND_URL wins', () => {
    expect(resolveFrontendUrl({ ...CODESPACE, FRONTEND_URL: 'https://staging.verdict.example.com' })).toMatchObject({ url: 'https://staging.verdict.example.com', source: 'FRONTEND_URL' })
  })

  it('needs both Codespaces variables, and ignores values that are not plain host labels', () => {
    expect(resolveFrontendUrl({ CODESPACE_NAME: 'x' }).source).toBe('default')
    expect(resolveFrontendUrl({ GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }).source).toBe('default')
    expect(resolveFrontendUrl({ CODESPACE_NAME: 'evil.com/x?', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }).source).toBe('default')
    expect(resolveFrontendUrl({ CODESPACE_NAME: 'x', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'evil.com/#' }).source).toBe('default')
  })

  it('isLocalhostUrl', () => {
    for (const u of ['http://localhost:5173', 'http://127.0.0.1', 'http://0.0.0.0:80', 'http://[::1]:5173', 'http://app.localhost']) expect(isLocalhostUrl(u)).toBe(true)
    for (const u of ['https://fuzzy-robot-x7g-5173.app.github.dev', 'https://localhost.example.com', 'not a url']) expect(isLocalhostUrl(u)).toBe(false)
  })
})

describe('emailed links and startup messages', () => {
  it('the nudge/verification config uses the derived URL in a Codespace', () => {
    expect(loadNudgeConfig({ ...process.env, ...CODESPACE, FRONTEND_URL: 'http://localhost:5173' }).frontendUrl).toBe('https://fuzzy-robot-x7g-5173.app.github.dev')
    expect(loadNudgeConfig({ ...process.env, CODESPACE_NAME: undefined, FRONTEND_URL: 'http://localhost:5173' }).frontendUrl).toBe('http://localhost:5173')
  })

  it('logs the resolved URL; warns loudly only when a real provider would send localhost links', () => {
    const local = resolveFrontendUrl({})
    const derived = resolveFrontendUrl({ ...CODESPACE })
    expect(frontendUrlStartupMessages(derived, true)).toEqual({ info: 'Frontend URL for email links and CORS: https://fuzzy-robot-x7g-5173.app.github.dev (from codespaces)' })
    expect(frontendUrlStartupMessages(local, false).warn).toBeUndefined()
    expect(frontendUrlStartupMessages(local, true).warn).toMatch(/^A REAL email provider is active but email links point at http:\/\/localhost:5173/)
  })
})

/** Set the Codespaces variables for one test and put back whatever was there before. */
const saved: Record<string, string | undefined> = {}
function enterCodespace() {
  for (const k of Object.keys(CODESPACE)) saved[k] = process.env[k]
  Object.assign(process.env, CODESPACE)
}
function leaveCodespace() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('a real verification email in a Codespace', () => {
  afterEach(leaveCodespace)

  it('carries the forwarded https link, not localhost', async () => {
    const { api, cleanup, uniqueUser } = await import('./helpers')
    const { flushAccountEmails, setTransactionalProviderForTests } = await import('../src/auth/mailer')
    const { mockProvider } = await import('./nudges/fixtures')
    const { prisma } = await import('../src/lib/prisma')
    enterCodespace()
    const m = mockProvider()
    setTransactionalProviderForTests(m.provider)
    const u = uniqueUser()
    await api().post('/api/auth/register').send(u)
    await flushAccountEmails()
    setTransactionalProviderForTests(null)
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } })
    await cleanup([user.id])
    expect(m.sent[0].text).toContain('https://fuzzy-robot-x7g-5173.app.github.dev/verify-email#id=')
    expect(m.sent[0].text).not.toContain('localhost')
  })
})

describe('CORS with the derived URL', () => {
  let app: Express
  beforeAll(async () => {
    enterCodespace()
    jest.resetModules()
    app = (await import('../src/app')).app
  })
  afterAll(() => {
    leaveCodespace()
    jest.resetModules()
  })

  it('allows the forwarded https origin and the local one; not others', async () => {
    expect(corsOrigins(resolveFrontendUrl({ ...CODESPACE }))).toEqual(['https://fuzzy-robot-x7g-5173.app.github.dev', 'http://localhost:5173'])
    expect(corsOrigins(resolveFrontendUrl({}))).toEqual(['http://localhost:5173'])
    // An explicit public FRONTEND_URL allows only itself, not localhost.
    expect(corsOrigins(resolveFrontendUrl({ FRONTEND_URL: 'https://verdict.example.com' }))).toEqual(['https://verdict.example.com'])
    const preflight = (origin: string) =>
      request(app).options('/api/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST')
    const forwarded = await preflight('https://fuzzy-robot-x7g-5173.app.github.dev')
    expect(forwarded.headers['access-control-allow-origin']).toBe('https://fuzzy-robot-x7g-5173.app.github.dev')
    expect(forwarded.headers['access-control-allow-credentials']).toBe('true')
    expect((await preflight('http://localhost:5173')).headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect((await preflight('https://evil.example.com')).headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('src/scripts/frontendUrl.ts (what .devcontainer/start.sh runs)', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/scripts/frontendUrl.ts'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    }).stdout.trim()

  it('prints the derived URL in a Codespace', () => {
    expect(run({ ...CODESPACE, FRONTEND_URL: 'http://localhost:5173' })).toBe('https://fuzzy-robot-x7g-5173.app.github.dev')
  }, 30_000)
})
