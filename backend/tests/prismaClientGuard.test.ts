import { Prisma } from '@prisma/client'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { assertPrismaClientCurrent, missingFromClient, OUT_OF_DATE_MESSAGE, PrismaClientOutOfDateError, REQUIRED_ENUMS, REQUIRED_MODELS } from '../src/lib/prismaClientGuard'

// A copy of the current client's datamodel that tests can damage, like an old client would be.
interface Datamodel {
  models: { name: string; fields: { name: string }[] }[]
  enums: { name: string; values: { name: string }[] }[]
}
const current = (): Datamodel => JSON.parse(JSON.stringify(Prisma.dmmf.datamodel)) as Datamodel

describe('Prisma client startup guard', () => {
  it('the generated client has everything the nudge and verification code use', () => {
    expect(missingFromClient()).toEqual([])
    expect(() => assertPrismaClientCurrent()).not.toThrow()
  })

  it('a client from before the nudge-delivery schema (no Nudge.claimedAt) fails with the fix', () => {
    const old = current()
    const nudge = old.models.find((m) => m.name === 'Nudge')
    if (!nudge) throw new Error('no Nudge model')
    nudge.fields = nudge.fields.filter((f) => f.name !== 'claimedAt')
    expect(() => assertPrismaClientCurrent(old)).toThrow(PrismaClientOutOfDateError)
    expect(() => assertPrismaClientCurrent(old)).toThrow(OUT_OF_DATE_MESSAGE)
    expect(missingFromClient(old)).toEqual(['Nudge.claimedAt'])
  })

  it('a client from before email verification (no token model, no rate-limit enum) lists what is missing', () => {
    const old = current()
    old.models = old.models.filter((m) => !['EmailVerificationToken', 'EmailRateEvent'].includes(m.name))
    old.enums = old.enums.filter((e) => e.name !== 'EmailRateKind')
    expect(missingFromClient(old)).toEqual(['model EmailVerificationToken', 'model EmailRateEvent', 'enum EmailRateKind'])
  })

  it('a missing enum value is caught (ReviewStage without TWO_WEEKS)', () => {
    const old = current()
    const stage = old.enums.find((e) => e.name === 'ReviewStage')
    if (!stage) throw new Error('no ReviewStage enum')
    stage.values = stage.values.filter((v) => v.name !== 'TWO_WEEKS')
    expect(missingFromClient(old)).toEqual(['ReviewStage.TWO_WEEKS'])
  })

  it('every required model, field and enum value exists in schema.prisma (the list cannot drift from the schema)', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
    const block = (kind: 'model' | 'enum', name: string) => schema.match(new RegExp(`^${kind} ${name} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? ''
    const missing: string[] = []
    for (const [model, fields] of Object.entries(REQUIRED_MODELS)) {
      const body = block('model', model)
      for (const f of fields) if (!new RegExp(`^\\s+${f}\\s`, 'm').test(body)) missing.push(`${model}.${f}`)
    }
    for (const [name, values] of Object.entries(REQUIRED_ENUMS)) {
      const body = block('enum', name)
      for (const v of values) if (!new RegExp(`^\\s+${v}\\b`, 'm').test(body)) missing.push(`${name}.${v}`)
    }
    expect(missing).toEqual([])
  })
})

describe('boot (src/index.ts) with an out-of-date client', () => {
  it('exits 1 before listening, with the fix in the message', async () => {
    const backend = path.join(__dirname, '..')
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-r', path.join(__dirname, 'fixtures', 'staleClient.ts'), 'src/index.ts'],
      { cwd: backend, env: { ...process.env, NODE_ENV: 'test', PORT: '0', LOG_LEVEL: 'error' } }
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null) // still running: it started listening instead of failing fast
      }, 15_000)
      child.on('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    expect(code).toBe(1)
    expect(out).toContain('Prisma client is out of date: run npx prisma generate')
    expect(out).toContain('model EmailRateEvent')
  }, 30_000)
})
