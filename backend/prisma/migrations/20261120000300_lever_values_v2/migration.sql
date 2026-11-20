-- Lever values with evidence and review status (docs/adr-generation-run.md D2, D3 step 4).

CREATE TYPE "ValueStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');
CREATE TYPE "ValueOrigin" AS ENUM ('EXTRACTED', 'MANUAL', 'PHASE_A');
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "AcceptMode" AS ENUM ('SINGLE', 'BULK');
CREATE TYPE "FetchOutcome" AS ENUM ('OK', 'ROBOTS_DISALLOWED', 'NOT_ALLOWED', 'HTTP_ERROR', 'BLOCKED', 'UNSUPPORTED_TYPE', 'TOO_LARGE', 'NETWORK', 'SCANNED_PDF');

-- The fictional Phase A sample products: every lever value is sample data and nobody reviewed them.
-- Data-based, so a real product with reviews is never deleted.
DELETE FROM "products" p
WHERE EXISTS (SELECT 1 FROM "product_lever_values" v WHERE v."productId" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "product_lever_values" v WHERE v."productId" = p."id" AND NOT v."isSample")
  AND NOT EXISTS (SELECT 1 FROM "review_threads" t WHERE t."productId" = p."id");

ALTER TABLE "product_lever_values" DROP CONSTRAINT "product_lever_values_leverId_fkey";
ALTER TABLE "product_lever_values" DROP CONSTRAINT "product_lever_values_recordedById_fkey";
ALTER TABLE "product_lever_values" DROP CONSTRAINT "product_lever_values_source_url_iff_url";
DROP INDEX "product_lever_values_productId_leverId_key";
DROP INDEX "product_lever_values_leverId_idx";

ALTER TABLE "product_lever_values"
  ADD COLUMN "definitionId" TEXT,
  ADD COLUMN "status" "ValueStatus" NOT NULL DEFAULT 'PROPOSED',
  ADD COLUMN "origin" "ValueOrigin" NOT NULL DEFAULT 'PHASE_A',
  ADD COLUMN "statedValue" TEXT,
  ADD COLUMN "statedUnit" TEXT,
  ADD COLUMN "evidenceQuote" TEXT,
  ADD COLUMN "confidence" "Confidence",
  ADD COLUMN "unknownReason" TEXT,
  ADD COLUMN "adminAttested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attestedFetchOutcome" "FetchOutcome",
  ADD COLUMN "runId" TEXT,
  ADD COLUMN "extractedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "acceptMode" "AcceptMode",
  ADD COLUMN "editedById" TEXT,
  ADD COLUMN "editedAt" TIMESTAMP(3),
  ADD COLUMN "originalValue" JSONB,
  ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Remaining Phase A values (admin-entered, real products) keep their typed value as a PROPOSED value of
-- origin PHASE_A. They carry no evidence quote, so they can never be accepted (CHECK below); extraction
-- or a manual value with a quote replaces them. Values of levers that were not carried over are dropped.
UPDATE "product_lever_values" v SET
  "definitionId" = m."definitionId",
  "statedValue" = COALESCE(v."sourceLabel", CASE WHEN v."sourceType" = 'ADMIN_ENTERED' THEN 'Entered by admin (Phase A)' END),
  "createdAt" = v."recordedAt"
FROM "_phase_a_lever_map" m WHERE m."leverId" = v."leverId";
DELETE FROM "product_lever_values" WHERE "definitionId" IS NULL;
-- Two Phase A levers with the same name now share one definition: keep the newest value per product.
DELETE FROM "product_lever_values" a USING "product_lever_values" b
WHERE a."productId" = b."productId" AND a."definitionId" = b."definitionId"
  AND (a."recordedAt", a."id") < (b."recordedAt", b."id");

ALTER TABLE "product_lever_values"
  ALTER COLUMN "definitionId" SET NOT NULL,
  ALTER COLUMN "origin" DROP DEFAULT,
  ALTER COLUMN "updatedAt" DROP DEFAULT,
  DROP COLUMN "leverId",
  DROP COLUMN "isSample",
  DROP COLUMN "recordedAt",
  DROP COLUMN "recordedById",
  DROP COLUMN "sourceLabel",
  DROP COLUMN "sourceType";

DROP TYPE "ValueSourceType";
DROP TABLE "_phase_a_lever_map";
DROP TABLE "value_levers";
DROP FUNCTION "value_levers_check_approved_count"();

CREATE INDEX "product_lever_values_definitionId_idx" ON "product_lever_values"("definitionId");
CREATE INDEX "product_lever_values_runId_idx" ON "product_lever_values"("runId");
CREATE UNIQUE INDEX "product_lever_values_productId_definitionId_key" ON "product_lever_values"("productId", "definitionId");
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "lever_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- product_lever_values.runId gets its foreign key with the generation_runs table (next migration).

-- ── Invariants (CHECKs and triggers; migrate diff ignores them) ────────────────────────────────────
-- An accepted, known value has its evidence: a quote and an https source.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_accepted_has_evidence"
  CHECK ("status" <> 'ACCEPTED' OR "isUnknown" OR (
    "evidenceQuote" IS NOT NULL AND btrim("evidenceQuote") <> '' AND "sourceUrl" LIKE 'https://%'));
-- Phase A values have no evidence and can never be accepted.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_phase_a_not_accepted"
  CHECK ("origin" <> 'PHASE_A' OR "status" <> 'ACCEPTED');
-- An unknown has no value.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_unknown_is_empty"
  CHECK (NOT "isUnknown" OR ("valueNumber" IS NULL AND "valueText" IS NULL AND "valueBool" IS NULL
    AND cardinality("valueList") = 0 AND "dimLengthIn" IS NULL AND "dimWidthIn" IS NULL AND "dimHeightIn" IS NULL));
-- A review decision records when (and who: every API path sets reviewedById; it becomes null only if that
-- user is deleted); acceptMode only on accepted values.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_reviewed_has_time"
  CHECK ("status" = 'PROPOSED' OR "reviewedAt" IS NOT NULL);
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_accept_mode"
  CHECK (("status" = 'ACCEPTED') = ("acceptMode" IS NOT NULL));
-- Admin-attested is a manual value whose source could not be fetched.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_attested_is_manual"
  CHECK (NOT "adminAttested" OR ("origin" = 'MANUAL' AND "attestedFetchOutcome" IS NOT NULL AND "attestedFetchOutcome" <> 'OK'));

-- Values on safety-flagged levers (all car-seat levers) and manual values are accepted one by one:
-- a BULK accept of either is refused here as well as in the API.
CREATE FUNCTION "product_lever_values_no_bulk_safety"() RETURNS trigger AS $$
DECLARE
  node_id TEXT;
BEGIN
  IF NEW."status" = 'ACCEPTED' AND NEW."acceptMode" = 'BULK' THEN
    IF NEW."origin" = 'MANUAL' THEN
      RAISE EXCEPTION 'manual values cannot be bulk-accepted' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "nodeId" INTO node_id FROM "products" WHERE "id" = NEW."productId";
    IF (SELECT "safetyFlag" FROM "lever_definitions" WHERE "id" = NEW."definitionId")
       OR (node_id IS NOT NULL AND "node_is_safety_critical"(node_id))
       OR EXISTS (SELECT 1 FROM "node_levers" WHERE "nodeId" = node_id AND "definitionId" = NEW."definitionId" AND "safety") THEN
      RAISE EXCEPTION 'values on safety-flagged levers must be accepted one by one' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_lever_values_no_bulk_safety"
  BEFORE INSERT OR UPDATE ON "product_lever_values"
  FOR EACH ROW EXECUTE FUNCTION "product_lever_values_no_bulk_safety"();
