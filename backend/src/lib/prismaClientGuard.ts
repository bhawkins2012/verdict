// Startup guard: is the generated Prisma client the one this code was written against?
//
// `prisma migrate deploy` updates the database but not node_modules/.prisma/client. After pulling schema
// changes without `prisma generate`, the old client still loads, and the first query that uses a new model
// or field fails deep inside a background task ("Unknown argument `claimedAt`", "Cannot read properties of
// undefined (reading 'updateMany')"). This check runs at boot and fails fast with the fix instead.
//
// Two checks, both at boot:
// 1. When the source schema and the generated client's copy of it are both on disk (dev, Codespaces, CI,
//    a dist/ build run from the repo), they must be identical: this catches ANY model or field change.
// 2. REQUIRED lists what the nudge engine, email verification and value levers read and write, checked against the
//    loaded client's datamodel: it also works where the schema file is not shipped. Adding a field to that
//    code? Add it here; tests/prismaClientGuard.test.ts checks this list against schema.prisma.
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

export const REQUIRED_MODELS: Record<string, readonly string[]> = {
  User: [
    'email', 'emailVerified', 'emailVerifiedAt', 'emailNudgesEnabled', 'emailNudgesConsentAt',
    'emailNudgesFirstEnabledAt', 'nudgePromptDismissedAt', 'timezone', 'nudgeSendHour', 'passwordHash', 'role',
  ],
  Product: ['category', 'categoryId'],
  ReviewThread: ['purchasedAt', 'startedAt', 'stagesCompleted'],
  Review: ['stage', 'capturedAt'],
  Nudge: [
    'targetStage', 'scheduledFor', 'sendAt', 'sentAt', 'completedAt', 'status', 'channel', 'endedReason',
    'attempts', 'lastAttemptAt', 'lastError', 'claimedAt', 'providerMessageId', 'snoozedUntil', 'snoozeCount',
  ],
  EmailVerificationToken: ['userId', 'email', 'tokenHash', 'createdAt', 'expiresAt', 'usedAt', 'supersededAt'],
  EmailRateEvent: ['kind', 'key', 'createdAt', 'sentAt'],
  Category: ['slug', 'name', 'searchTerms', 'createdById', 'leversPublishedAt', 'leversPublishedById'],
  ValueLever: [
    'categoryId', 'name', 'type', 'inputFormat', 'unit', 'explanation', 'relatedNeeds', 'allowedValues', 'status',
    'position', 'origin', 'runId', 'approvedById', 'approvedAt', 'retiredById', 'retiredAt', 'editedById', 'editedAt',
  ],
  LeverCandidateRun: [
    'categoryId', 'createdById', 'mode', 'status', 'model', 'servedModel', 'input', 'output', 'error',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd', 'createdAt', 'finishedAt',
  ],
  SurveyImport: ['categoryId', 'filename', 'uploadedById', 'uploadedAt', 'rowCount'],
  SurveyRanking: ['importId', 'leverName', 'rank', 'respondentCount'],
  ProductLeverValue: [
    'productId', 'leverId', 'isUnknown', 'valueNumber', 'unit', 'valueText', 'valueBool', 'valueList',
    'dimLengthIn', 'dimWidthIn', 'dimHeightIn', 'detail', 'sourceType', 'sourceUrl', 'sourceLabel', 'isSample',
    'recordedById', 'recordedAt',
  ],
}

export const REQUIRED_ENUMS: Record<string, readonly string[]> = {
  ReviewStage: ['INITIAL', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS', 'CUSTOM'],
  NudgeChannel: ['EMAIL', 'IN_APP'],
  NudgeEndReason: ['REVIEW_SUBMITTED', 'SUPERSEDED', 'USER_SKIPPED'],
  NudgeStatus: ['PENDING', 'SENDING', 'SENT', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'FAILED'],
  EmailRateKind: ['VERIFICATION_EMAIL', 'SIGNUP_ATTEMPT_EMAIL', 'EMAIL_CHANGE_ATTEMPT'],
  UserRole: ['USER', 'ADMIN'],
  LeverType: ['MEASUREMENT', 'CATEGORY', 'COMPATIBILITY_LIST', 'BOOLEAN'],
  LeverInputFormat: ['SINGLE', 'DIMENSIONS'],
  LeverStatus: ['CANDIDATE', 'APPROVED', 'RETIRED'],
  LeverOrigin: ['GENERATED', 'ADMIN'],
  LeverRunStatus: ['RUNNING', 'SUCCEEDED', 'FAILED'],
  LeverRunMode: ['LIVE', 'DRY_RUN'],
  ValueSourceType: ['URL', 'ADMIN_ENTERED'],
}

export const OUT_OF_DATE_MESSAGE = 'Prisma client is out of date: run npx prisma generate (in backend/: cd backend && npx prisma generate)'

interface Datamodel {
  models: readonly { name: string; fields: readonly { name: string }[] }[]
  enums: readonly { name: string; values: readonly { name: string }[] }[]
}

/** backend/, from src/lib or dist/lib. */
const BACKEND_DIR = path.resolve(__dirname, '..', '..')

/**
 * true: the generated client was built from a different schema.prisma; false: identical; null: one of the
 * files is not on disk (e.g. a deployment without the schema), so only the REQUIRED check applies.
 */
export function generatedSchemaDiffers(
  schemaPath = path.join(BACKEND_DIR, 'prisma', 'schema.prisma'),
  generatedPath = path.join(BACKEND_DIR, 'node_modules', '.prisma', 'client', 'schema.prisma')
): boolean | null {
  if (!fs.existsSync(schemaPath) || !fs.existsSync(generatedPath)) return null
  const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
  return normalize(fs.readFileSync(schemaPath, 'utf8')) !== normalize(fs.readFileSync(generatedPath, 'utf8'))
}

/** The loaded client's datamodel, or null if this client does not expose Prisma.dmmf (other generators). */
function loadedDatamodel(): Datamodel | null {
  const dmmf = (Prisma as { dmmf?: { datamodel?: Datamodel } }).dmmf
  return dmmf?.datamodel ?? null
}

/** What the client is missing, e.g. ["Nudge.claimedAt", "model EmailRateEvent"]. Empty when current. */
export function missingFromClient(datamodel: Datamodel | null = loadedDatamodel()): string[] {
  if (!datamodel) return [] // cannot inspect this client; the schema-file comparison still applies
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

/** Throws PrismaClientOutOfDateError if the client is stale. Call before listening. */
export function assertPrismaClientCurrent(datamodel?: Datamodel, schemaPaths?: { schema: string; generated: string }): void {
  const missing = missingFromClient(datamodel)
  if (generatedSchemaDiffers(schemaPaths?.schema, schemaPaths?.generated)) {
    missing.push('prisma/schema.prisma changed since the client was generated')
  }
  if (missing.length > 0) throw new PrismaClientOutOfDateError(missing)
}
