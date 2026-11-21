-- The generation run: stages, the cost ledger, extraction items, fetched text, brand domains and per-host
-- fetch state (docs/adr-generation-run.md D2, D5, D6, section 5 A1).

CREATE TYPE "GenerationRunKind" AS ENUM ('NODE', 'EXPLAINER');
CREATE TYPE "GenerationRunStatus" AS ENUM ('ACTIVE', 'READY_FOR_REVIEW', 'STALLED', 'FAILED', 'CANCELLED', 'PUBLISHED');
CREATE TYPE "RunStage" AS ENUM ('PLACE', 'LEVERS', 'DISCOVER', 'VERIFY', 'EXTRACT', 'EXPLAIN');
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'STALLED');
CREATE TYPE "ItemStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'WAITING');
CREATE TYPE "CallStatus" AS ENUM ('RESERVED', 'DONE', 'FAILED');
CREATE TYPE "FetchedKind" AS ENUM ('PAGE', 'PDF', 'HOMEPAGE');
CREATE TYPE "BrandDomainStatus" AS ENUM ('VERIFIED', 'PENDING_CONFIRMATION', 'REJECTED');
CREATE TYPE "BrandVerifiedVia" AS ENUM ('AUTOMATIC', 'ADMIN');

CREATE TABLE "generation_runs" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "GenerationRunKind" NOT NULL,
    "mode" "LeverRunMode" NOT NULL,
    "status" "GenerationRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "notes" TEXT,
    "model" TEXT NOT NULL,
    "capUsd" DECIMAL(10,4) NOT NULL,
    "estimateUsd" DECIMAL(10,4),
    "warning" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "generation_run_stages" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" "RunStage" NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "output" JSONB,

    CONSTRAINT "generation_run_stages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "generation_calls" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" "RunStage" NOT NULL,
    "productId" TEXT,
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "status" "CallStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedUsd" DECIMAL(10,6) NOT NULL,
    "costUsd" DECIMAL(10,6),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "webSearches" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "generation_calls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "extraction_items" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "fetchOutcome" "FetchOutcome",
    "httpStatus" INTEGER,
    "fetchedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" JSONB,
    "documents" JSONB,
    "error" TEXT,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extraction_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fetched_pages" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "FetchedKind" NOT NULL,
    "runId" TEXT,
    "productId" TEXT,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fetched_pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brand_domains" (
    "id" TEXT NOT NULL,
    "brandKey" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "status" "BrandDomainStatus" NOT NULL,
    "verifiedVia" "BrandVerifiedVia",
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "checkResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_domains_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fetch_hosts" (
    "host" TEXT NOT NULL,
    "lastFetchAt" TIMESTAMP(3),
    "robotsTxt" TEXT,
    "robotsStatus" TEXT,
    "robotsFetchedAt" TIMESTAMP(3),
    "crawlDelaySec" INTEGER,
    "blockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fetch_hosts_pkey" PRIMARY KEY ("host")
);

CREATE INDEX "generation_runs_nodeId_createdAt_idx" ON "generation_runs"("nodeId", "createdAt");
CREATE INDEX "generation_runs_status_idx" ON "generation_runs"("status");
CREATE INDEX "generation_run_stages_status_heartbeatAt_idx" ON "generation_run_stages"("status", "heartbeatAt");
CREATE UNIQUE INDEX "generation_run_stages_runId_stage_key" ON "generation_run_stages"("runId", "stage");
CREATE INDEX "generation_calls_createdAt_idx" ON "generation_calls"("createdAt");
CREATE INDEX "generation_calls_runId_idx" ON "generation_calls"("runId");
CREATE INDEX "extraction_items_runId_status_idx" ON "extraction_items"("runId", "status");
CREATE UNIQUE INDEX "extraction_items_runId_productId_key" ON "extraction_items"("runId", "productId");
CREATE INDEX "fetched_pages_expiresAt_idx" ON "fetched_pages"("expiresAt");
CREATE INDEX "fetched_pages_url_idx" ON "fetched_pages"("url");
CREATE UNIQUE INDEX "brand_domains_host_key" ON "brand_domains"("host");
CREATE INDEX "brand_domains_brandKey_idx" ON "brand_domains"("brandKey");

ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "taxonomy_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "generation_run_stages" ADD CONSTRAINT "generation_run_stages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "generation_calls" ADD CONSTRAINT "generation_calls_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extraction_items" ADD CONSTRAINT "extraction_items_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extraction_items" ADD CONSTRAINT "extraction_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fetched_pages" ADD CONSTRAINT "fetched_pages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brand_domains" ADD CONSTRAINT "brand_domains_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_lever_values" ADD CONSTRAINT "product_lever_values_runId_fkey" FOREIGN KEY ("runId") REFERENCES "generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invariants (migrate diff ignores partial indexes' predicates and CHECKs) ───────────────────────
-- One unfinished run per node.
CREATE UNIQUE INDEX "generation_runs_one_open_per_node" ON "generation_runs"("nodeId")
  WHERE "status" IN ('ACTIVE', 'STALLED');
ALTER TABLE "generation_calls" ADD CONSTRAINT "generation_calls_cost_settled"
  CHECK (("status" = 'RESERVED') = ("finishedAt" IS NULL) AND "reservedUsd" >= 0 AND ("costUsd" IS NULL OR "costUsd" >= 0));
ALTER TABLE "brand_domains" ADD CONSTRAINT "brand_domains_host_normalized"
  CHECK ("host" = lower("host") AND "host" NOT LIKE 'www.%' AND "host" <> '');
ALTER TABLE "brand_domains" ADD CONSTRAINT "brand_domains_verified_has_how"
  CHECK (("status" = 'VERIFIED') = ("verifiedVia" IS NOT NULL AND "verifiedAt" IS NOT NULL));
ALTER TABLE "fetch_hosts" ADD CONSTRAINT "fetch_hosts_host_normalized"
  CHECK ("host" = lower("host") AND "host" NOT LIKE 'www.%' AND "host" <> '');
ALTER TABLE "fetched_pages" ADD CONSTRAINT "fetched_pages_expires_within_a_day"
  CHECK ("expiresAt" > "fetchedAt" AND "expiresAt" <= "fetchedAt" + interval '24 hours');
