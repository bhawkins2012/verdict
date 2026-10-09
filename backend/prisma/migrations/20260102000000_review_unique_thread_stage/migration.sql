-- One review per stage per thread, enforced by the database.
-- If this fails with a duplicate-key error, existing data has duplicate stages. Find them with:
--   SELECT "threadId", stage, COUNT(*) FROM reviews GROUP BY 1, 2 HAVING COUNT(*) > 1;
-- and resolve them (keep the earliest) before re-running `prisma migrate deploy`.

-- CreateIndex
CREATE UNIQUE INDEX "reviews_threadId_stage_key" ON "reviews"("threadId", "stage");
