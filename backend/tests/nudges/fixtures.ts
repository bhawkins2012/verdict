import { randomUUID } from 'crypto'
import { Prisma, ReviewStage } from '@prisma/client'
import { prisma } from '../../src/lib/prisma'
import { EmailMessage, EmailProvider } from '../../src/nudges/providers'
import { SenderDeps } from '../../src/nudges/sender'

const created = { users: [] as string[], products: [] as string[] }

export async function makeUser(overrides: Partial<Prisma.UserCreateInput> = {}) {
  const id = randomUUID().slice(0, 8)
  const user = await prisma.user.create({
    data: {
      email: `n_${id}@example.com`,
      username: `n_${id}`,
      passwordHash: 'not-used',
      emailNudgesEnabled: true,
      emailVerified: true,
      timezone: 'UTC',
      nudgeSendHour: 9,
      ...overrides,
    },
  })
  created.users.push(user.id)
  return user
}

export async function makeProduct(name = 'Test Kettle') {
  const product = await prisma.product.create({ data: { name: `${name} ${randomUUID().slice(0, 6)}`, category: 'test' } })
  created.products.push(product.id)
  return product
}

/** A thread whose reviews were written at the given times (startedAt = first review, as in the app). */
export async function makeThread(
  userId: string,
  reviews: Array<{ stage: ReviewStage; at: Date }>,
  opts: { purchasedAt?: Date; productName?: string } = {}
) {
  const product = await makeProduct(opts.productName)
  return prisma.reviewThread.create({
    data: {
      userId,
      productId: product.id,
      startedAt: reviews[0]?.at ?? new Date(),
      purchasedAt: opts.purchasedAt,
      stagesCompleted: reviews.map((r) => r.stage),
      reviews: { create: reviews.map((r) => ({ stage: r.stage, scoreOverall: 7, capturedAt: r.at })) },
    },
  })
}

export async function cleanupNudgeFixtures() {
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.product.deleteMany({ where: { id: { in: created.products } } })
  created.users.length = 0
  created.products.length = 0
}

/** A provider double: records messages; behavior per call is configurable. */
export function mockProvider(opts: { real?: boolean; send?: (m: EmailMessage) => Promise<{ providerMessageId: string }> } = {}) {
  const sent: EmailMessage[] = []
  const send = jest.fn(async (m: EmailMessage) => {
    // Widen the race window between concurrent callers.
    await new Promise((r) => setTimeout(r, 25))
    if (opts.send) return opts.send(m)
    sent.push(m)
    return { providerMessageId: `mock-${sent.length}` }
  })
  const provider: EmailProvider & { send: typeof send } = { name: opts.real ? 'resend' : 'console', real: opts.real ?? false, send }
  return { provider, sent, send }
}

export function senderDeps(provider: EmailProvider, now: Date, config: Partial<SenderDeps['config']> = {}): SenderDeps {
  return {
    db: prisma,
    provider,
    now: () => now,
    config: {
      dailyCap: 1,
      maxAttempts: 5,
      requireVerifiedEmail: true,
      frontendUrl: 'http://app.test',
      fromEmail: 'Verdict <reminders@verdict.test>',
      unsubscribeSecret: 'test-unsubscribe-secret-0123456789-abcdefghij',
      postalAddress: '1 Test Street, Testville',
      ...config,
    },
  }
}

export const days = (n: number) => n * 24 * 60 * 60 * 1000
export const at = (iso: string) => new Date(iso)

/**
 * Run tasks so they hit the `nudges` table at the same moment: a gate transaction holds an ACCESS
 * EXCLUSIVE lock, every task blocks at its first read of the table, then the gate opens and they all
 * proceed together. Makes races (claims, caps, concurrent syncs) deterministic instead of luck-based.
 */
export async function raceOnNudges<T>(tasks: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let locked!: () => void
  const isLocked = new Promise<void>((r) => (locked = r))
  const gateTx = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "nudges" IN ACCESS EXCLUSIVE MODE')
      locked()
      await gate
    },
    { timeout: 15_000 }
  )
  await isLocked
  const running = tasks.map((t) => t())
  await new Promise((r) => setTimeout(r, 300)) // let every task reach the lock
  open()
  await gateTx
  return Promise.allSettled(running)
}
