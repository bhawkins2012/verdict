import { spawn } from 'child_process'
import net from 'net'
import path from 'path'
import { TEST_DATABASE_URL } from './testEnv'

// scripts/wait-for-postgres.js is what .devcontainer/start.sh uses to decide Postgres is ready.
const script = path.join(__dirname, '..', '..', 'scripts', 'wait-for-postgres.js')

interface Result { code: number | null; out: string; ms: number }

function probe(databaseUrl: string, timeoutSeconds: number): Promise<Result> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [script, String(timeoutSeconds)], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }))
  })
}

const realUrl = new URL(TEST_DATABASE_URL)
const withPort = (port: number) => {
  const u = new URL(TEST_DATABASE_URL)
  u.hostname = '127.0.0.1'
  u.port = String(port)
  return u.toString()
}

// A listener that accepts TCP but is not Postgres until `readyAfterMs` (then forwards to the real server).
// With readyAfterMs = Infinity it never becomes Postgres. This is what a published Docker port looks like
// while the container is still initialising.
function fakePublishedPort(readyAfterMs: number): Promise<{ port: number; close: () => void }> {
  const t0 = Date.now()
  const server = net.createServer((client) => {
    client.on('error', () => {})
    if (Date.now() - t0 < readyAfterMs) return void client.end()
    const upstream = net.connect(Number(realUrl.port || 5432), realUrl.hostname)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.pipe(upstream)
    upstream.pipe(client)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })
    )
  )
}

function tcpConnects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

describe('wait-for-postgres probe', () => {
  it('is not fooled by a port that accepts TCP but is not Postgres: it fails, after retrying', async () => {
    const fake = await fakePublishedPort(Infinity)
    try {
      // This is all the old wait-for-port.js checked, and it passes:
      expect(await tcpConnects(fake.port)).toBe(true)

      const r = await probe(withPort(fake.port), 4)

      expect(r.code).toBe(1)
      expect(r.out).toMatch(/attempt 2/)
      expect(r.out).toMatch(/Timed out after 4s/)
      expect(r.ms).toBeLessThan(10000)
    } finally {
      fake.close()
    }
  })

  it('keeps retrying while the port is up but Postgres is not, then succeeds once it is', async () => {
    const fake = await fakePublishedPort(3000)
    try {
      const r = await probe(withPort(fake.port), 15)

      expect(r.code).toBe(0)
      expect(r.out).toMatch(/not ready \(attempt 1/)
      expect(r.out).toMatch(/answered SELECT 1/)
      expect(r.ms).toBeGreaterThanOrEqual(2500)
    } finally {
      fake.close()
    }
  })

  it('succeeds immediately against a real, ready Postgres', async () => {
    const r = await probe(TEST_DATABASE_URL, 15)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/answered SELECT 1 \(attempt 1/)
  })

  it('fails fast, without retrying, on a bad DATABASE_URL', async () => {
    const r = await probe('not-a-url', 30)
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/configuration error/i)
    expect(r.ms).toBeLessThan(5000)
  })

  it('never prints credentials', async () => {
    const r = await probe(withPort(1), 2)
    expect(r.out).not.toContain(new URL(TEST_DATABASE_URL).password)
  })
})
