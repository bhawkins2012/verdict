-- Email verification (docs/adr-email-verification.md D9): tokens (only hashes are stored), database-backed
-- rate-limit events, and when an address was verified. Additive only.

-- CreateEnum
CREATE TYPE "EmailRateKind" AS ENUM ('VERIFICATION_EMAIL', 'SIGNUP_ATTEMPT_EMAIL', 'EMAIL_CHANGE_ATTEMPT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_rate_events" (
    "id" TEXT NOT NULL,
    "kind" "EmailRateKind" NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_rate_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_verification_tokens_userId_createdAt_idx" ON "email_verification_tokens"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "email_rate_events_kind_key_createdAt_idx" ON "email_rate_events"("kind", "key", "createdAt");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Users already marked verified (the seed) get a verification time so the two columns agree.
UPDATE "users" SET "emailVerifiedAt" = "updatedAt" WHERE "emailVerified" = true AND "emailVerifiedAt" IS NULL;
