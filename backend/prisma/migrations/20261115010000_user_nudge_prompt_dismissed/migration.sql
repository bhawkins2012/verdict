-- The user declined the post-first-review email opt-in prompt (docs/adr-nudges.md, Q2).
-- Nullable, no default, no backfill: existing users have not declined.
ALTER TABLE "users" ADD COLUMN "nudgePromptDismissedAt" TIMESTAMP(3);
