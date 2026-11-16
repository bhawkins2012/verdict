// Startup guard: is the generated Prisma client the one this code was written against?
//
// `prisma migrate deploy` updates the database but not node_modules/.prisma/client. After pulling schema
// changes without `prisma generate`, the old client still loads, and the first query that uses a new model
// or field fails deep inside a background task ("Unknown argument `claimedAt`", "Cannot read properties of
// undefined (reading 'updateMany')"). This check runs at boot and fails fast with the fix instead.
//
// REQUIRED lists what the nudge engine and email verification read and write. Adding a field to that code?
// Add it here; tests/prismaClientGuard.test.ts checks that the current client satisfies this list.
import { Prisma } from '@prisma/client'

export const REQUIRED_MODELS: Record<string, readonly string[]> = {
  User: [
    'email', 'emailVerified', 'emailVerifiedAt', 'emailNudgesEnabled', 'emailNudgesConsentAt',
    'emailNudgesFirstEnabledAt', 'nudgePromptDismissedAt', 'timezone', 'nudgeSendHour', 'passwordHash',
  ],
  ReviewThread: ['purchasedAt', 'startedAt', 'stagesCompleted'],
  Review: ['stage', 'capturedAt'],
  Nudge: [
    'targetStage', 'scheduledFor', 'sendAt', 'sentAt', 'completedAt', 'status', 'channel', 'endedReason',
    'attempts', 'lastAttemptAt', 'lastError', 'claimedAt', 'providerMessageId', 'snoozedUntil', 'snoozeCount',
  ],
  EmailVerificationToken: ['userId', 'email', 'tokenHash', 'createdAt', 'expiresAt', 'usedAt', 'supersededAt'],
  EmailRateEvent: ['kind', 'key', 'createdAt', 'sentAt'],
}

export const REQUIRED_ENUMS: Record<string, readonly string[]> = {
  ReviewStage: ['TWO_WEEKS'],
  NudgeStatus: ['PENDING', 'SENDING', 'SENT', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'FAILED'],
  EmailRateKind: ['VERIFICATION_EMAIL', 'SIGNUP_ATTEMPT_EMAIL', 'EMAIL_CHANGE_ATTEMPT'],
}

export const OUT_OF_DATE_MESSAGE = 'Prisma client is out of date: run npx prisma generate (in backend/: cd backend && npx prisma generate)'

interface Datamodel {
  models: readonly { name: string; fields: readonly { name: string }[] }[]
  enums: readonly { name: string; values: readonly { name: string }[] }[]
}

/** What the client is missing, e.g. ["Nudge.claimedAt", "model EmailRateEvent"]. Empty when current. */
export function missingFromClient(datamodel: Datamodel = Prisma.dmmf.datamodel): string[] {
  const missing: string[] = []
  for (const [model, fields] of Object.entries(REQUIRED_MODELS)) {
    const m = datamodel.models.find((x) => x.name === model)
    if (!m) {
      missing.push(`model ${model}`)
      continue
    }
    for (const f of fields) if (!m.fields.some((x) => x.name === f)) missing.push(`${model}.${f}`)
  }
  for (const [name, values] of Object.entries(REQUIRED_ENUMS)) {
    const e = datamodel.enums.find((x) => x.name === name)
    if (!e) {
      missing.push(`enum ${name}`)
      continue
    }
    for (const v of values) if (!e.values.some((x) => x.name === v)) missing.push(`${name}.${v}`)
  }
  return missing
}

export class PrismaClientOutOfDateError extends Error {
  constructor(readonly missing: string[]) {
    super(`${OUT_OF_DATE_MESSAGE}. Missing from the generated client: ${missing.join(', ')}`)
    this.name = 'PrismaClientOutOfDateError'
  }
}

/** Throws PrismaClientOutOfDateError if the client lacks anything the code needs. Call before listening. */
export function assertPrismaClientCurrent(datamodel?: Datamodel): void {
  const missing = missingFromClient(datamodel)
  if (missing.length > 0) throw new PrismaClientOutOfDateError(missing)
}
