# Architecture Decisions

## ADR-001: Longitudinal Review Threading

**Decision:** Group all reviews for a user+product pair into a `ReviewThread`, with each stage as a child `Review`.

**Rationale:** A thread is the unit of longitudinal tracking. Keeping stages as children of a thread enables:
- Easy drift computation (compare first and last child)
- Atomic nudge scheduling (schedule next stage after each write)
- Survivorship curve aggregation across all threads for a product

---

## ADR-002: Drift Score Definition

**Decision:** `driftScore = latestScore - initialScore`

**Rationale:** Simple, interpretable, and directional. A score of `-2.5` immediately communicates "this product disappointed over time." Stored at the thread level and averaged at the product level.

**Future:** Could weight by time elapsed (steeper drop in month 1 vs year 3 = different signals).

---

## ADR-003: ML Service as Separate Python Sidecar

**Decision:** Run the recommendation engine as a separate FastAPI service, called via HTTP from the Node.js backend.

**Rationale:**
- Python's ML ecosystem (scikit-learn, torch, pandas) is unmatched
- Keeps the Node API thin and focused on CRUD + business logic
- ML service can be scaled independently
- Enables hot-reloading model weights without restarting the API

---

## ADR-004: Stage Weights in Recommendation Scoring

**Decision:** Long-term reviews contribute more to the user-item matrix than initial reviews.

**Weight table:**
```
INITIAL:       0.60
ONE_WEEK:      0.70
ONE_MONTH:     0.85
THREE_MONTHS:  0.90
SIX_MONTHS:    0.95
ONE_YEAR:      1.00
TWO_YEARS:     1.00
```

**Rationale:** The core insight of Verdict is that long-term satisfaction is a stronger signal than first impressions. This weighting ensures the recommendation engine learns from durable opinions, not purchase excitement.

---

## ADR-005: Nudge Storage Strategy

**Decision:** Store nudges in PostgreSQL as the source of truth; use BullMQ for delivery scheduling. If Redis is unavailable, fall back gracefully — nudges stay in DB and can be surfaced via polling.

**Rationale:** Redis is fast but ephemeral. If a BullMQ job is lost during a Redis restart, the DB record survives. A fallback cron job can re-enqueue pending nudges on startup.

---

## ADR-006: Recommendation Fallback Strategy

**Decision:** If the ML service is down or returns an error, the Node API falls back to top-rated products by `avgRatingLongterm`.

**Rationale:** Recommendations should never fail silently. A popularity-based fallback is better UX than an empty page, and it's still surfacing quality products.

---

## ADR-007: NLP Enrichment is Non-Blocking

**Decision:** NLP enrichment (sentiment score, key topics) is best-effort. If the ML service is unavailable, the review is saved without NLP fields. Those fields are nullable in the schema.

**Rationale:** Reviews are user-generated content. The core action (submitting a review) should never be blocked by a downstream service. NLP enrichment can be backfilled later with a migration job.

---

## Planned Future ADRs

- **ADR-008:** Review aggregation pipeline design (scrapers, dedup strategy, trust scoring)
- **ADR-009:** Matrix factorization upgrade path (SVD → two-tower neural net)
- **ADR-010:** Push notification strategy for nudges (web push vs email vs SMS)
- **ADR-011:** Multi-tenancy model (if white-labeling becomes a requirement)
