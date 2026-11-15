-- Nudge delivery (docs/adr-nudges.md D8). Applied with `prisma migrate deploy` only.

-- CreateEnum
CREATE TYPE "NudgeChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "NudgeEndReason" AS ENUM ('REVIEW_SUBMITTED', 'SUPERSEDED', 'USER_SKIPPED');

-- AlterEnum. The new values are not used anywhere in this migration (PostgreSQL does not allow using an
-- enum value in the same transaction that added it).
ALTER TYPE "NudgeStatus" ADD VALUE 'SENDING';
ALTER TYPE "NudgeStatus" ADD VALUE 'FAILED';

-- DropIndex (replaced by (status, sendAt) below)
DROP INDEX "nudges_scheduledFor_status_idx";

-- AlterTable: delivery bookkeeping.
-- sendAt and updatedAt are NOT NULL in the schema but existing rows need a value first:
-- sendAt is backfilled from the due date; updatedAt gets a temporary default that is then dropped
-- (Prisma's @updatedAt has no database default, so leaving it would be schema drift).
ALTER TABLE "nudges" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channel" "NudgeChannel",
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "endedReason" "NudgeEndReason",
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "sendAt" TIMESTAMP(3),
ADD COLUMN     "snoozeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "nudges" SET "sendAt" = "scheduledFor";
ALTER TABLE "nudges" ALTER COLUMN "sendAt" SET NOT NULL;
ALTER TABLE "nudges" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable: optional purchase date anchors the schedule (ADR D3).
ALTER TABLE "review_threads" ADD COLUMN     "purchasedAt" TIMESTAMP(3);

-- AlterTable: nudge preferences. Email stays off for every existing and new user until they opt in (ADR D5).
ALTER TABLE "users" ADD COLUMN     "emailNudgesConsentAt" TIMESTAMP(3),
ADD COLUMN     "emailNudgesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nudgeSendHour" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- CreateIndex
CREATE INDEX "nudges_status_sendAt_idx" ON "nudges"("status", "sendAt");

-- After deploy, the nudge planner re-plans every thread once (idempotent), anchoring existing nudges.
