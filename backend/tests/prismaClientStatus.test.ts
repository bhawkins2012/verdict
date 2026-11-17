// The generated-client check used by scripts/doctor.sh (scripts/prisma-client-status.js).
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

describe('scripts/prisma-client-status.js (used by scripts/doctor.sh)', () => {
  const script = path.join(__dirname, '..', '..', 'scripts', 'prisma-client-status.js')
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    return { code: r.status, json: JSON.parse(r.stdout) as { status: string } }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-status-'))
  const schema = path.join(dir, 'schema.prisma')
  const generated = path.join(dir, 'generated.prisma')
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('current: the generated copy matches the schema (ignoring trailing whitespace and CRLF)', () => {
    fs.writeFileSync(schema, 'model A {\n  id Int @id\n}\n')
    fs.writeFileSync(generated, 'model A {\r\n  id Int @id   \r\n}')
    expect(run(schema, generated)).toEqual({ code: 0, json: expect.objectContaining({ status: 'current' }) })
  })

  it('stale: the schema gained a field the client does not have', () => {
    fs.writeFileSync(schema, 'model A {\n  id Int @id\n  claimedAt DateTime?\n}\n')
    fs.writeFileSync(generated, 'model A {\n  id Int @id\n}\n')
    expect(run(schema, generated)).toEqual({ code: 1, json: expect.objectContaining({ status: 'stale' }) })
  })

  it('missing: no generated client at all', () => {
    expect(run(schema, path.join(dir, 'nope.prisma'))).toEqual({ code: 2, json: expect.objectContaining({ status: 'missing' }) })
  })

  it("this repo's own client is current (defaults resolve to backend/)", () => {
    expect(run()).toEqual({ code: 0, json: expect.objectContaining({ status: 'current' }) })
  })
})

describe('scripts/doctor.sh: the Prisma client check', () => {
  const repo = path.join(__dirname, '..', '..')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-prisma-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  const doctor = (schema: string, generated: string) =>
    spawnSync('bash', ['scripts/doctor.sh'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PRISMA_SCHEMA_PATH: schema, PRISMA_GENERATED_SCHEMA_PATH: generated },
    }).stdout.split('\n')

  it('fails a stale client and suggests the exact fix', () => {
    const schema = path.join(dir, 'schema.prisma')
    const generated = path.join(dir, 'generated.prisma')
    fs.writeFileSync(schema, 'model A {\n  id Int @id\n  claimedAt DateTime?\n}\n')
    fs.writeFileSync(generated, 'model A {\n  id Int @id\n}\n')
    const lines = doctor(schema, generated)
    const i = lines.findIndex((l) => l.includes('Prisma client is out of date'))
    expect(lines[i]).toMatch(/\[FAIL\]/)
    expect(lines[i + 1]).toContain('fix: cd backend && npx prisma generate')
  }, 60_000)

  it('reports a missing client, and OK when the copies match', () => {
    const schema = path.join(dir, 'ok.prisma')
    fs.writeFileSync(schema, 'model A {\n  id Int @id\n}\n')
    expect(doctor(schema, path.join(dir, 'none.prisma')).find((l) => l.includes('Prisma client'))).toMatch(/\[FAIL\] Prisma client not generated/)
    expect(doctor(schema, schema).find((l) => l.includes('Prisma client'))).toMatch(/\[ OK \] Prisma client matches/)
  }, 60_000)
})
