-- Categories, value levers, generation runs, survey imports and product lever values (docs/adr-levers.md).

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "LeverType" AS ENUM ('MEASUREMENT', 'CATEGORY', 'COMPATIBILITY_LIST', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "LeverInputFormat" AS ENUM ('SINGLE', 'DIMENSIONS');

-- CreateEnum
CREATE TYPE "LeverStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "LeverOrigin" AS ENUM ('GENERATED', 'ADMIN');

-- CreateEnum
CREATE TYPE "LeverRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeverRunMode" AS ENUM ('LIVE', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "ValueSourceType" AS ENUM ('URL', 'ADMIN_ENTERED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "searchTerms" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "leversPublishedAt" TIMESTAMP(3),
    "leversPublishedById" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "value_levers" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LeverType" NOT NULL,
    "inputFormat" "LeverInputFormat" NOT NULL DEFAULT 'SINGLE',
    "unit" TEXT,
    "explanation" TEXT NOT NULL,
    "relatedNeeds" TEXT[],
    "allowedValues" TEXT[],
    "status" "LeverStatus" NOT NULL DEFAULT 'CANDIDATE',
    "position" INTEGER,
    "origin" "LeverOrigin" NOT NULL,
    "runId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "value_levers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lever_candidate_runs" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdById" TEXT,
    "mode" "LeverRunMode" NOT NULL,
    "status" "LeverRunStatus" NOT NULL DEFAULT 'RUNNING',
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "costUsd" DECIMAL(10,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "lever_candidate_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_imports" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount" INTEGER NOT NULL,

    CONSTRAINT "survey_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_rankings" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "leverName" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "respondentCount" INTEGER NOT NULL,

    CONSTRAINT "survey_rankings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_lever_values" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leverId" TEXT NOT NULL,
    "isUnknown" BOOLEAN NOT NULL DEFAULT false,
    "valueNumber" DOUBLE PRECISION,
    "unit" TEXT,
    "valueText" TEXT,
    "valueBool" BOOLEAN,
    "valueList" TEXT[],
    "dimLengthIn" DOUBLE PRECISION,
    "dimWidthIn" DOUBLE PRECISION,
    "dimHeightIn" DOUBLE PRECISION,
    "detail" TEXT,
    "sourceType" "ValueSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "sourceLabel" TEXT,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_lever_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "value_levers_categoryId_status_idx" ON "value_levers"("categoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "value_levers_categoryId_position_key" ON "value_levers"("categoryId", "position");

-- CreateIndex
CREATE INDEX "lever_candidate_runs_mode_createdAt_idx" ON "lever_candidate_runs"("mode", "createdAt");

-- CreateIndex
CREATE INDEX "lever_candidate_runs_categoryId_createdAt_idx" ON "lever_candidate_runs"("categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "survey_imports_categoryId_uploadedAt_idx" ON "survey_imports"("categoryId", "uploadedAt");

-- CreateIndex
CREATE INDEX "survey_rankings_importId_idx" ON "survey_rankings"("importId");

-- CreateIndex
CREATE INDEX "product_lever_values_leverId_idx" ON "product_lever_values"("leverId");

-- CreateIndex
CREATE UNIQUE INDEX "product_lever_values_productId_leverId_key" ON "product_lever_values"("productId", "leverId");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_leversPublishedById_fkey" FOREIGN KEY ("leversPublishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_runId_fkey" FOREIGN KEY ("runId") REFERENCES "lever_candidate_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_retiredById_fkey" FOREIGN KEY ("retiredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lever_candidate_runs" ADD CONSTRAINT "lever_candidate_runs_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lever_candidate_runs" ADD CONSTRAINT "lever_candidate_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_imports" ADD CONSTRAINT "survey_imports_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_imports" ADD CONSTRAINT "survey_imports_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_rankings" ADD CONSTRAINT "survey_rankings_importId_fkey" FOREIGN KEY ("importId") REFERENCES "survey_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_leverId_fkey" FOREIGN KEY ("leverId") REFERENCES "value_levers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Backfill (ADR D2) ─────────────────────────────────────────────────────────────────────────────
-- One category per distinct existing products.category value. Ids are opaque strings, so a uuid is fine
-- here (the app generates cuids). Backfilled categories have no levers, so they stay hidden from browse.
INSERT INTO "categories" ("id", "slug", "name", "searchTerms", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s.slug, initcap(replace(s.slug, '-', ' ')), ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT lower(btrim("category")) AS slug FROM "products" WHERE btrim("category") <> '') s;

UPDATE "products" p SET "categoryId" = c."id" FROM "categories" c WHERE lower(btrim(p."category")) = c."slug";

-- ── Invariants Prisma cannot express (migrate diff ignores CHECK constraints and triggers) ─────────
ALTER TABLE "categories" ADD CONSTRAINT "categories_slug_normalized"
  CHECK ("slug" = lower(btrim("slug")) AND "slug" <> '');

-- An approved lever has a position 1-5 and an approval time; nothing else has a position.
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_position_iff_approved"
  CHECK (("status" = 'APPROVED') = ("position" IS NOT NULL));
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_position_range"
  CHECK ("position" IS NULL OR "position" BETWEEN 1 AND 5);
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_approved_has_time"
  CHECK ("status" <> 'APPROVED' OR "approvedAt" IS NOT NULL);
-- Only a measurement has a unit, and every measurement has one. Dimensions are measurements in cu ft.
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_unit_iff_measurement"
  CHECK (("type" = 'MEASUREMENT') = ("unit" IS NOT NULL AND btrim("unit") <> ''));
ALTER TABLE "value_levers" ADD CONSTRAINT "value_levers_dimensions_shape"
  CHECK ("inputFormat" = 'SINGLE' OR ("type" = 'MEASUREMENT' AND "unit" = 'cu ft'));

-- Every value has a source: a URL exactly when the source type is URL.
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_source_url_iff_url"
  CHECK (("sourceType" = 'URL') = ("sourceUrl" IS NOT NULL AND btrim("sourceUrl") <> ''));

ALTER TABLE "survey_rankings" ADD CONSTRAINT "survey_rankings_numbers"
  CHECK ("rank" >= 1 AND "respondentCount" >= 0);

-- A category has exactly zero or five approved (published) levers. Checked at commit, so the publish
-- transaction can retire the old set and approve the new one in any order.
CREATE FUNCTION "value_levers_check_approved_count"() RETURNS trigger AS $$
DECLARE
  cat TEXT;
  n INTEGER;
BEGIN
  FOREACH cat IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."categoryId" END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."categoryId" END
  ] LOOP
    IF cat IS NOT NULL THEN
      SELECT count(*) INTO n FROM "value_levers" WHERE "categoryId" = cat AND "status" = 'APPROVED';
      IF n <> 0 AND n <> 5 THEN
        RAISE EXCEPTION 'category % would have % approved value levers; it must have exactly 0 or 5', cat, n
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "value_levers_approved_count"
  AFTER INSERT OR UPDATE OR DELETE ON "value_levers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "value_levers_check_approved_count"();
