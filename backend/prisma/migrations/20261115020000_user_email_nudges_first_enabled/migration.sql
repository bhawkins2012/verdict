-- First time the user turned email reminders on; never cleared (the opt-in prompt is shown only to
-- users who have neither opted in at some point nor declined it).
ALTER TABLE "users" ADD COLUMN "emailNudgesFirstEnabledAt" TIMESTAMP(3);

-- Backfill: users who are opted in now have opted in at least once, at their consent time.
-- (Users who opted in and later out cannot be recovered: their consent time was cleared on opt-out.)
UPDATE "users" SET "emailNudgesFirstEnabledAt" = COALESCE("emailNudgesConsentAt", CURRENT_TIMESTAMP)
WHERE "emailNudgesEnabled" = true;
