-- One nudge per (thread, stage). Older code inserted a new nudge on every review, so duplicates can exist.
-- Keep exactly one row per (threadId, targetStage), preferring the most meaningful state:
--   COMPLETED > SENT > PENDING > anything else (SKIPPED, CANCELLED)
-- and, within the same state, the latest scheduledFor (then the highest id, for determinism).
DELETE FROM "nudges" AS n
USING (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "threadId", "targetStage"
           ORDER BY CASE "status"
                      WHEN 'COMPLETED' THEN 0
                      WHEN 'SENT'      THEN 1
                      WHEN 'PENDING'   THEN 2
                      ELSE 3
                    END,
                    "scheduledFor" DESC,
                    "id" DESC
         ) AS rn
  FROM "nudges"
) AS ranked
WHERE n."id" = ranked."id"
  AND ranked.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "nudges_threadId_targetStage_key" ON "nudges"("threadId", "targetStage");
