-- Taxonomy (docs/adr-generation-run.md D1, D2, D3 step 1): the Phase A `categories` table becomes
-- `taxonomy_nodes` (ids kept), with a kind, a primary parent and "also listed in" secondary parents.

CREATE TYPE "NodeKind" AS ENUM ('NAVIGATION', 'DECISION');

-- Used by the lever migration that follows; a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "LeverOrigin" ADD VALUE 'REFERENCE';

-- ── categories → taxonomy_nodes ────────────────────────────────────────────────────────────────────
ALTER TABLE "categories" RENAME TO "taxonomy_nodes";
ALTER TABLE "taxonomy_nodes" RENAME CONSTRAINT "categories_pkey" TO "taxonomy_nodes_pkey";
ALTER INDEX "categories_slug_key" RENAME TO "taxonomy_nodes_slug_key";
ALTER TABLE "taxonomy_nodes" RENAME CONSTRAINT "categories_slug_normalized" TO "taxonomy_nodes_slug_normalized";
ALTER TABLE "taxonomy_nodes" RENAME CONSTRAINT "categories_createdById_fkey" TO "taxonomy_nodes_createdById_fkey";
ALTER TABLE "taxonomy_nodes" DROP CONSTRAINT "categories_leversPublishedById_fkey";
ALTER TABLE "taxonomy_nodes" RENAME COLUMN "leversPublishedAt" TO "publishedAt";
ALTER TABLE "taxonomy_nodes" RENAME COLUMN "leversPublishedById" TO "publishedById";

ALTER TABLE "taxonomy_nodes"
  ADD COLUMN "kind" "NodeKind" NOT NULL DEFAULT 'DECISION',
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "safetyCritical" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "explainer" TEXT,
  ADD COLUMN "explainerChildLines" JSONB,
  ADD COLUMN "explainerApprovedAt" TIMESTAMP(3),
  ADD COLUMN "explainerApprovedById" TEXT;

CREATE INDEX "taxonomy_nodes_parentId_idx" ON "taxonomy_nodes"("parentId");
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "taxonomy_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_explainerApprovedById_fkey" FOREIGN KEY ("explainerApprovedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── products.categoryId → nodeId, survey_imports.categoryId → nodeId ───────────────────────────────
ALTER TABLE "products" RENAME COLUMN "categoryId" TO "nodeId";
ALTER INDEX "products_categoryId_idx" RENAME TO "products_nodeId_idx";
ALTER TABLE "products" RENAME CONSTRAINT "products_categoryId_fkey" TO "products_nodeId_fkey";

ALTER TABLE "survey_imports" RENAME COLUMN "categoryId" TO "nodeId";
ALTER INDEX "survey_imports_categoryId_uploadedAt_idx" RENAME TO "survey_imports_nodeId_uploadedAt_idx";
ALTER TABLE "survey_imports" RENAME CONSTRAINT "survey_imports_categoryId_fkey" TO "survey_imports_nodeId_fkey";

-- ── "Also listed in" ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE "node_secondary_parents" (
    "nodeId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_secondary_parents_pkey" PRIMARY KEY ("nodeId","parentId")
);
CREATE INDEX "node_secondary_parents_parentId_idx" ON "node_secondary_parents"("parentId");
ALTER TABLE "node_secondary_parents" ADD CONSTRAINT "node_secondary_parents_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "taxonomy_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_secondary_parents" ADD CONSTRAINT "node_secondary_parents_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "taxonomy_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma cannot express (migrate diff ignores CHECKs and triggers) ────────────────────
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_explainer_navigation_only"
  CHECK ("kind" = 'NAVIGATION' OR ("explainer" IS NULL AND "explainerApprovedAt" IS NULL));
ALTER TABLE "taxonomy_nodes" ADD CONSTRAINT "taxonomy_nodes_published_decision_only"
  CHECK ("kind" = 'DECISION' OR "publishedAt" IS NULL);
ALTER TABLE "node_secondary_parents" ADD CONSTRAINT "node_secondary_parents_not_self" CHECK ("nodeId" <> "parentId");

-- Ancestors of a node through primary and secondary edges (UNION, so it ends even on bad data).
CREATE FUNCTION "taxonomy_has_ancestor"(start_id TEXT, target_id TEXT) RETURNS BOOLEAN AS $$
  WITH RECURSIVE edges(child, parent) AS (
    SELECT "id", "parentId" FROM "taxonomy_nodes" WHERE "parentId" IS NOT NULL
    UNION ALL
    SELECT "nodeId", "parentId" FROM "node_secondary_parents"
  ), anc(id) AS (
    SELECT start_id
    UNION
    SELECT e.parent FROM anc JOIN edges e ON e.child = anc.id
  )
  SELECT EXISTS (SELECT 1 FROM anc WHERE id = target_id);
$$ LANGUAGE sql STABLE;

-- Any new or changed edge: the parent must be a navigation node, and the child must not be an ancestor
-- of the parent (no cycles). One transaction-scoped lock serializes edge changes, so two concurrent
-- edits cannot each pass and together close a cycle.
CREATE FUNCTION "taxonomy_check_edge"(child_id TEXT, parent_id TEXT) RETURNS VOID AS $$
DECLARE
  parent_kind "NodeKind";
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('taxonomy_edges'));
  SELECT "kind" INTO parent_kind FROM "taxonomy_nodes" WHERE "id" = parent_id;
  IF parent_kind IS DISTINCT FROM 'NAVIGATION' THEN
    RAISE EXCEPTION 'taxonomy parent % of % must be a navigation node', parent_id, child_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF "taxonomy_has_ancestor"(parent_id, child_id) THEN
    RAISE EXCEPTION 'taxonomy edge % -> % would create a cycle', child_id, parent_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "taxonomy_nodes_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."parentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId") THEN
    PERFORM "taxonomy_check_edge"(NEW."id", NEW."parentId");
  END IF;
  -- A decision node is a leaf; a navigation node holds no products (levers: checked by node_levers).
  IF NEW."kind" = 'DECISION' AND (TG_OP = 'INSERT' OR OLD."kind" <> 'DECISION') THEN
    PERFORM pg_advisory_xact_lock(hashtext('taxonomy_edges'));
    IF EXISTS (SELECT 1 FROM "taxonomy_nodes" WHERE "parentId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "node_secondary_parents" WHERE "parentId" = NEW."id") THEN
      RAISE EXCEPTION 'node % has children, so it cannot be a decision node', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'NAVIGATION' AND TG_OP = 'UPDATE' AND OLD."kind" <> 'NAVIGATION' THEN
    IF EXISTS (SELECT 1 FROM "products" WHERE "nodeId" = NEW."id") THEN
      RAISE EXCEPTION 'node % holds products, so it cannot be a navigation node', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "taxonomy_nodes_check"
  AFTER INSERT OR UPDATE OF "parentId", "kind" ON "taxonomy_nodes"
  FOR EACH ROW EXECUTE FUNCTION "taxonomy_nodes_check"();

CREATE FUNCTION "node_secondary_parents_check"() RETURNS trigger AS $$
BEGIN
  PERFORM "taxonomy_check_edge"(NEW."nodeId", NEW."parentId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "node_secondary_parents_check"
  AFTER INSERT OR UPDATE ON "node_secondary_parents"
  FOR EACH ROW EXECUTE FUNCTION "node_secondary_parents_check"();
