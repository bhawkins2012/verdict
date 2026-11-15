-- Product cadence change: nudges at 2 weeks, 3 months, 1 year, 2 years (docs/adr-nudges.md section 7).
-- Adds the TWO_WEEKS stage, ordered after ONE_WEEK. The older stages stay valid: existing reviews keep
-- them and users can still write them manually.
--
-- This migration only adds the value. PostgreSQL does not allow using a new enum value in the
-- transaction that added it, so nothing here references TWO_WEEKS. Out-of-cadence nudges are
-- cancelled by the planner after deploy, not by this migration.
ALTER TYPE "ReviewStage" ADD VALUE 'TWO_WEEKS' AFTER 'ONE_WEEK';
