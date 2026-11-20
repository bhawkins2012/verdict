-- Launch taxonomy (docs/adr-generation-run.md D3 step 2, D4). Product structure every environment needs,
-- so it lives in a migration, not the seed. Idempotent by slug: an existing row keeps its id (the Phase A
-- `strollers` and `car-seats` categories become the Strollers and Car seats navigation nodes).

-- Nothing published in Phase A carries over: the new gate needs evidence Phase A values do not have.
UPDATE "taxonomy_nodes" SET "publishedAt" = NULL, "publishedById" = NULL;

-- Navigation nodes hold no products: unplace the products of the two categories that become navigation
-- nodes (the admin "Unplaced products" list). Their `category` string stays (the ML service reads it).
UPDATE "products" SET "nodeId" = NULL
WHERE "nodeId" IN (SELECT "id" FROM "taxonomy_nodes" WHERE "slug" IN ('strollers', 'car-seats', 'baby-and-kids', 'seats'));

CREATE FUNCTION "pg_temp"."upsert_node"(p_slug TEXT, p_name TEXT, p_kind "NodeKind", p_parent TEXT, p_position INT,
                                        p_terms TEXT[], p_safety BOOLEAN) RETURNS VOID AS $$
BEGIN
  INSERT INTO "taxonomy_nodes" ("id", "slug", "name", "kind", "parentId", "position", "searchTerms", "safetyCritical", "updatedAt")
  VALUES (gen_random_uuid()::text, p_slug, p_name, p_kind,
          (SELECT "id" FROM "taxonomy_nodes" WHERE "slug" = p_parent), p_position, p_terms, p_safety, CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO UPDATE SET
    "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "parentId" = EXCLUDED."parentId",
    "position" = EXCLUDED."position", "searchTerms" = EXCLUDED."searchTerms",
    "safetyCritical" = EXCLUDED."safetyCritical", "updatedAt" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

SELECT "pg_temp"."upsert_node"('baby-and-kids', 'Baby and Kids', 'NAVIGATION', NULL, 0,
  ARRAY['baby', 'kids', 'baby gear', 'nursery'], false);
SELECT "pg_temp"."upsert_node"('seats', 'Seats', 'NAVIGATION', NULL, 1, ARRAY['seat', 'seats'], false);

SELECT "pg_temp"."upsert_node"('car-seats', 'Car seats', 'NAVIGATION', 'baby-and-kids', 1,
  ARRAY['car seat', 'carseat', 'baby car seat'], true);
SELECT "pg_temp"."upsert_node"('strollers', 'Strollers', 'NAVIGATION', 'baby-and-kids', 2,
  ARRAY['stroller', 'pram', 'pushchair', 'buggy'], false);

SELECT "pg_temp"."upsert_node"('infant-car-seats', 'Infant car seats', 'DECISION', 'car-seats', 1,
  ARRAY['infant car seat', 'infant seat', 'rear-facing infant seat', 'bucket seat'], false);
SELECT "pg_temp"."upsert_node"('convertible-car-seats', 'Convertible and all-in-one car seats', 'DECISION', 'car-seats', 2,
  ARRAY['convertible car seat', 'all-in-one car seat', 'all in one car seat', '3-in-1 car seat', 'toddler car seat'], false);
SELECT "pg_temp"."upsert_node"('booster-seats', 'Booster seats', 'DECISION', 'car-seats', 3,
  ARRAY['booster seat', 'high-back booster', 'backless booster', 'booster'], false);

SELECT "pg_temp"."upsert_node"('full-size-strollers', 'Full-size strollers', 'DECISION', 'strollers', 1,
  ARRAY['full-size stroller', 'full size stroller', 'standard stroller', 'modular stroller', 'travel system'], false);
SELECT "pg_temp"."upsert_node"('travel-strollers', 'Travel strollers (incl. umbrella)', 'DECISION', 'strollers', 2,
  ARRAY['travel stroller', 'umbrella stroller', 'compact stroller', 'lightweight stroller'], false);
SELECT "pg_temp"."upsert_node"('jogging-strollers', 'Jogging strollers', 'DECISION', 'strollers', 3,
  ARRAY['jogging stroller', 'running stroller', 'jogger'], false);
SELECT "pg_temp"."upsert_node"('double-strollers', 'Double strollers', 'DECISION', 'strollers', 4,
  ARRAY['double stroller', 'twin stroller', 'side-by-side stroller', 'tandem stroller', 'sibling stroller'], false);

-- Car seats is also listed in Seats.
INSERT INTO "node_secondary_parents" ("nodeId", "parentId")
SELECT c."id", s."id" FROM "taxonomy_nodes" c, "taxonomy_nodes" s WHERE c."slug" = 'car-seats' AND s."slug" = 'seats'
ON CONFLICT DO NOTHING;
