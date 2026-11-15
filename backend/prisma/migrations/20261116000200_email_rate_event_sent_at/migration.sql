-- When the provider accepted the email (docs/adr-email-verification.md D4). Address slots whose email was
-- never sent stop counting after a few minutes. Existing events are treated as sent.
-- AlterTable
ALTER TABLE "email_rate_events" ADD COLUMN     "sentAt" TIMESTAMP(3);

UPDATE "email_rate_events" SET "sentAt" = "createdAt" WHERE "sentAt" IS NULL;
