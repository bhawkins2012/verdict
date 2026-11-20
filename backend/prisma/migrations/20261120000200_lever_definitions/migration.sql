-- Shared lever definitions and per-node levers (docs/adr-generation-run.md D2, D3 step 3).
-- Phase A `value_levers` rows move here; the table is dropped by the next migration, after the values.

CREATE TABLE "lever_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "type" "LeverType" NOT NULL,
    "inputFormat" "LeverInputFormat" NOT NULL DEFAULT 'SINGLE',
    "unit" TEXT,
    "explanation" TEXT NOT NULL,
    "relatedNeeds" TEXT[],
    "allowedValues" TEXT[],
    "safetyFlag" BOOLEAN NOT NULL DEFAULT false,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "origin" "LeverOrigin" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "lever_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lever_definitions_nameKey_key" ON "lever_definitions"("nameKey");
ALTER TABLE "lever_definitions" ADD CONSTRAINT "lever_definitions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lever_definitions" ADD CONSTRAINT "lever_definitions_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "node_levers" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "status" "LeverStatus" NOT NULL DEFAULT 'CANDIDATE',
    "position" INTEGER,
    "safety" BOOLEAN NOT NULL DEFAULT false,
    "origin" "LeverOrigin" NOT NULL,
    "runId" TEXT,
    "note" TEXT,
    "published" JSONB,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_levers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "node_levers_nodeId_status_idx" ON "node_levers"("nodeId", "status");
CREATE UNIQUE INDEX "node_levers_nodeId_definitionId_key" ON "node_levers"("nodeId", "definitionId");
CREATE UNIQUE INDEX "node_levers_nodeId_position_key" ON "node_levers"("nodeId", "position");
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "taxonomy_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "lever_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_retiredById_fkey" FOREIGN KEY ("retiredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- node_levers.runId gets its foreign key with the generation_runs table (later migration).

-- ── Move Phase A levers ────────────────────────────────────────────────────────────────────────────
-- One definition per normalized name (the oldest lever with that name wins); the map is used by the
-- values migration and then dropped.
CREATE TABLE "_phase_a_lever_map" ("leverId" TEXT PRIMARY KEY, "definitionId" TEXT NOT NULL);

INSERT INTO "lever_definitions" ("id", "name", "nameKey", "type", "inputFormat", "unit", "explanation", "relatedNeeds",
                                 "allowedValues", "origin", "createdAt", "updatedAt", "editedById", "editedAt")
SELECT DISTINCT ON (k.key) v."id", btrim(v."name"), k.key, v."type", v."inputFormat", v."unit", v."explanation",
       v."relatedNeeds", v."allowedValues", v."origin", v."createdAt", CURRENT_TIMESTAMP, v."editedById", v."editedAt"
FROM "value_levers" v
CROSS JOIN LATERAL (SELECT lower(regexp_replace(btrim(v."name"), '\s+', ' ', 'g')) AS key) k
ORDER BY k.key, v."createdAt", v."id";

INSERT INTO "_phase_a_lever_map" ("leverId", "definitionId")
SELECT v."id", d."id" FROM "value_levers" v
JOIN "lever_definitions" d ON d."nameKey" = lower(regexp_replace(btrim(v."name"), '\s+', ' ', 'g'));

-- The five Phase A stroller levers become REFERENCE candidates on Full-size strollers (an input to its run;
-- nothing published). Levers of other navigation nodes (the car-seat test run's candidates) are kept as
-- history only, in lever_candidate_runs.output. Levers of decision nodes stay as candidates there.
INSERT INTO "node_levers" ("id", "nodeId", "definitionId", "status", "origin", "createdAt", "updatedAt")
SELECT DISTINCT ON (fs."id", m."definitionId") gen_random_uuid()::text, fs."id", m."definitionId", 'CANDIDATE', 'REFERENCE',
       v."createdAt", CURRENT_TIMESTAMP
FROM "value_levers" v
JOIN "_phase_a_lever_map" m ON m."leverId" = v."id"
JOIN "taxonomy_nodes" c ON c."id" = v."categoryId" AND c."slug" = 'strollers'
JOIN "taxonomy_nodes" fs ON fs."slug" = 'full-size-strollers'
WHERE v."status" = 'APPROVED'
ORDER BY fs."id", m."definitionId", v."createdAt";

INSERT INTO "node_levers" ("id", "nodeId", "definitionId", "status", "origin", "createdAt", "updatedAt")
SELECT DISTINCT ON (c."id", m."definitionId") gen_random_uuid()::text, c."id", m."definitionId", 'CANDIDATE', v."origin",
       v."createdAt", CURRENT_TIMESTAMP
FROM "value_levers" v
JOIN "_phase_a_lever_map" m ON m."leverId" = v."id"
JOIN "taxonomy_nodes" c ON c."id" = v."categoryId" AND c."kind" = 'DECISION'
WHERE v."status" <> 'RETIRED'
ORDER BY c."id", m."definitionId", v."createdAt"
ON CONFLICT ("nodeId", "definitionId") DO NOTHING;

-- ── Invariants (CHECKs and triggers; migrate diff ignores them) ────────────────────────────────────
ALTER TABLE "lever_definitions" ADD CONSTRAINT "lever_definitions_unit_iff_measurement"
  CHECK (("type" = 'MEASUREMENT') = ("unit" IS NOT NULL AND btrim("unit") <> ''));
ALTER TABLE "lever_definitions" ADD CONSTRAINT "lever_definitions_dimensions_shape"
  CHECK ("inputFormat" = 'SINGLE' OR ("type" = 'MEASUREMENT' AND "unit" = 'cu ft'));
ALTER TABLE "lever_definitions" ADD CONSTRAINT "lever_definitions_range"
  CHECK ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue");

ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_position_iff_approved"
  CHECK (("status" = 'APPROVED') = ("position" IS NOT NULL));
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_position_range"
  CHECK ("position" IS NULL OR "position" BETWEEN 1 AND 5);
ALTER TABLE "node_levers" ADD CONSTRAINT "node_levers_approved_has_time_and_snapshot"
  CHECK ("status" <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "published" IS NOT NULL));

-- Is a node safety-critical, itself or through any primary ancestor? (Car seats and everything under it.)
CREATE FUNCTION "node_is_safety_critical"(start_id TEXT) RETURNS BOOLEAN AS $$
  WITH RECURSIVE up(id, "parentId", "safetyCritical") AS (
    SELECT "id", "parentId", "safetyCritical" FROM "taxonomy_nodes" WHERE "id" = start_id
    UNION
    SELECT n."id", n."parentId", n."safetyCritical" FROM "taxonomy_nodes" n JOIN up ON n."id" = up."parentId"
  )
  SELECT COALESCE(bool_or("safetyCritical"), false) FROM up;
$$ LANGUAGE sql STABLE;

-- Levers belong to decision nodes; `safety` is forced true where the definition or the node requires it.
CREATE FUNCTION "node_levers_before_write"() RETURNS trigger AS $$
DECLARE
  k "NodeKind";
BEGIN
  SELECT "kind" INTO k FROM "taxonomy_nodes" WHERE "id" = NEW."nodeId";
  IF k IS DISTINCT FROM 'DECISION' THEN
    RAISE EXCEPTION 'levers belong to decision nodes; % is not one', NEW."nodeId" USING ERRCODE = 'check_violation';
  END IF;
  NEW."safety" := NEW."safety"
    OR (SELECT "safetyFlag" FROM "lever_definitions" WHERE "id" = NEW."definitionId")
    OR "node_is_safety_critical"(NEW."nodeId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "node_levers_before_write"
  BEFORE INSERT OR UPDATE ON "node_levers"
  FOR EACH ROW EXECUTE FUNCTION "node_levers_before_write"();

-- A definition that becomes safety-flagged flags every node lever that uses it.
CREATE FUNCTION "lever_definitions_safety_sync"() RETURNS trigger AS $$
BEGIN
  IF NEW."safetyFlag" AND NOT OLD."safetyFlag" THEN
    UPDATE "node_levers" SET "safety" = true WHERE "definitionId" = NEW."id" AND NOT "safety";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "lever_definitions_safety_sync"
  AFTER UPDATE OF "safetyFlag" ON "lever_definitions"
  FOR EACH ROW EXECUTE FUNCTION "lever_definitions_safety_sync"();

-- Moving a node or marking it safety-critical re-derives `safety` for the levers below it.
CREATE FUNCTION "taxonomy_nodes_safety_sync"() RETURNS trigger AS $$
BEGIN
  UPDATE "node_levers" SET "safety" = true
  WHERE NOT "safety" AND "node_is_safety_critical"("nodeId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "taxonomy_nodes_safety_sync"
  AFTER UPDATE OF "safetyCritical", "parentId" ON "taxonomy_nodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "taxonomy_nodes_safety_sync"();

-- A navigation node holds no levers.
CREATE OR REPLACE FUNCTION "taxonomy_nodes_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."parentId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."parentId" IS DISTINCT FROM OLD."parentId") THEN
    PERFORM "taxonomy_check_edge"(NEW."id", NEW."parentId");
  END IF;
  IF NEW."kind" = 'DECISION' AND (TG_OP = 'INSERT' OR OLD."kind" <> 'DECISION') THEN
    PERFORM pg_advisory_xact_lock(hashtext('taxonomy_edges'));
    IF EXISTS (SELECT 1 FROM "taxonomy_nodes" WHERE "parentId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "node_secondary_parents" WHERE "parentId" = NEW."id") THEN
      RAISE EXCEPTION 'node % has children, so it cannot be a decision node', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."kind" = 'NAVIGATION' AND TG_OP = 'UPDATE' AND OLD."kind" <> 'NAVIGATION' THEN
    IF EXISTS (SELECT 1 FROM "products" WHERE "nodeId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "node_levers" WHERE "nodeId" = NEW."id") THEN
      RAISE EXCEPTION 'node % holds products or levers, so it cannot be a navigation node', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A node has exactly zero or five approved (published) levers, checked at commit so the publish
-- transaction can retire the old set and approve the new one in any order.
CREATE FUNCTION "node_levers_check_approved_count"() RETURNS trigger AS $$
DECLARE
  nid TEXT;
  n INTEGER;
BEGIN
  FOREACH nid IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."nodeId" END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."nodeId" END
  ] LOOP
    IF nid IS NOT NULL THEN
      SELECT count(*) INTO n FROM "node_levers" WHERE "nodeId" = nid AND "status" = 'APPROVED';
      IF n <> 0 AND n <> 5 THEN
        RAISE EXCEPTION 'node % would have % approved levers; it must have exactly 0 or 5', nid, n
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "node_levers_approved_count"
  AFTER INSERT OR UPDATE OR DELETE ON "node_levers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "node_levers_check_approved_count"();
