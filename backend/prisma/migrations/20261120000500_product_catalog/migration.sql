-- Products in the catalog: discovery, automated approval, needs attention, listing and "also listed in"
-- (docs/adr-generation-run.md D2, section 5 A1).

CREATE TYPE "CatalogStatus" AS ENUM ('PROPOSED', 'APPROVED', 'NEEDS_ATTENTION', 'REJECTED');
CREATE TYPE "ApprovedVia" AS ENUM ('AUTO', 'ADMIN');

ALTER TABLE "products"
  ADD COLUMN "catalogStatus" "CatalogStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "approvedVia" "ApprovedVia",
  ADD COLUMN "attentionCheck" TEXT,
  ADD COLUMN "attentionReason" TEXT,
  ADD COLUMN "manufacturerUrl" TEXT,
  ADD COLUMN "discoveredByRunId" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isDryRun" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "products" ADD CONSTRAINT "products_discoveredByRunId_fkey" FOREIGN KEY ("discoveredByRunId") REFERENCES "generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "product_also_listed_in" (
    "productId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_also_listed_in_pkey" PRIMARY KEY ("productId","nodeId")
);
CREATE INDEX "product_also_listed_in_nodeId_idx" ON "product_also_listed_in"("nodeId");
ALTER TABLE "product_also_listed_in" ADD CONSTRAINT "product_also_listed_in_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_also_listed_in" ADD CONSTRAINT "product_also_listed_in_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "taxonomy_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants (CHECKs and triggers; migrate diff ignores them) ────────────────────────────────────
ALTER TABLE "products" ADD CONSTRAINT "products_listed_is_approved_and_placed"
  CHECK (NOT "listed" OR ("catalogStatus" = 'APPROVED' AND "nodeId" IS NOT NULL));
ALTER TABLE "products" ADD CONSTRAINT "products_approved_via"
  CHECK ("approvedVia" IS NULL OR "catalogStatus" = 'APPROVED');
ALTER TABLE "products" ADD CONSTRAINT "products_attention_has_reason"
  CHECK (("catalogStatus" = 'NEEDS_ATTENTION') = ("attentionCheck" IS NOT NULL));
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturer_url_https"
  CHECK ("manufacturerUrl" IS NULL OR "manufacturerUrl" LIKE 'https://%');

-- A product sits in a decision node (or is unplaced); "also listed in" names other decision nodes.
CREATE FUNCTION "products_check_node"() RETURNS trigger AS $$
BEGIN
  IF NEW."nodeId" IS NOT NULL AND (SELECT "kind" FROM "taxonomy_nodes" WHERE "id" = NEW."nodeId") <> 'DECISION' THEN
    RAISE EXCEPTION 'products belong to decision nodes; % is not one', NEW."nodeId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "products_check_node"
  AFTER INSERT OR UPDATE OF "nodeId" ON "products"
  FOR EACH ROW EXECUTE FUNCTION "products_check_node"();

CREATE FUNCTION "product_also_listed_in_check"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "kind" FROM "taxonomy_nodes" WHERE "id" = NEW."nodeId") <> 'DECISION' THEN
    RAISE EXCEPTION 'also listed in must name a decision node' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "products" WHERE "id" = NEW."productId" AND "nodeId" = NEW."nodeId") THEN
    RAISE EXCEPTION 'a product is not "also listed in" its own node' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_also_listed_in_check"
  AFTER INSERT OR UPDATE ON "product_also_listed_in"
  FOR EACH ROW EXECUTE FUNCTION "product_also_listed_in_check"();
