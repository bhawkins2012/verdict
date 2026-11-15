-- Email addresses are stored trimmed and lower-cased (docs/adr-email-verification.md, Q6).
--
-- 1. Refuse to run if existing rows would collide once normalized (e.g. "Alice@x.com" and
--    "alice@x.com " belong to two accounts). Nothing is changed; the error lists every offending
--    address so the accounts can be merged or renamed by hand before re-running the deploy.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(format('%s -> [%s]', normalized, addresses), '; ' ORDER BY normalized)
    INTO collisions
    FROM (
      SELECT lower(btrim("email")) AS normalized,
             string_agg(quote_literal("email"), ', ' ORDER BY "email") AS addresses
        FROM "users"
       GROUP BY lower(btrim("email"))
      HAVING count(*) > 1
    ) dupes;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot normalize user email addresses: these accounts would collide: %', collisions
      USING HINT = 'Merge or change these accounts'' email addresses, then run prisma migrate deploy again.';
  END IF;
END $$;

-- 2. Normalize existing rows.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));

-- 3. Enforce it in the schema: only normalized addresses can be stored, and lower(email) is unique.
--    (Prisma cannot express either; `prisma migrate diff` ignores them, so there is no drift.)
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));
