# ADR: Taxonomy and the unified generation run

**Status:** accepted with changes (branch `generation-run`). The answers to the open questions and the changes made at approval are in section 5; where section 5 differs from sections 1 to 4, section 5 wins.

**Product rules:** `docs/product-spec.md`, especially:
- "Product taxonomy"
- "Lever generation and review synthesis" (one generation run per decision node, publish gate, data sourcing rules)
- "Data model, phasing and open decisions"

**Builds on:** `docs/adr-levers.md` (Phase A). Phase A decisions stay unless this note changes them:
- Admin role from the database.
- Approve and publish in one step.
- `publicLevers()`-style single public read path.
- Dry-run default, in-process runs, the Anthropic SDK client.

## 1. Context

| Area | Phase A today | Consequence |
|---|---|---|
| Categories | `Category` is flat. `strollers` is published with five hand-picked levers; `car-seats` is unpublished, maybe with a candidate run; `kitchen`, `furniture`, `home` and `outdoor` were backfilled from product strings and are unpublished. | Categories become taxonomy nodes. Only decision nodes hold levers and products (D2, D3). |
| Levers | `ValueLever` belongs to one category. A lever's definition (name, type, unit) and its place in a category's five are one row. | It splits into a shared `LeverDefinition` and a per-node `NodeLever` (D2). |
| Runs | `LeverCandidateRun`: one API call, levers only, a run-count daily limit. | It is replaced by `GenerationRun`, with stages, a cost ledger and cost caps (D5). Old runs are kept as history. |
| Values | `ProductLeverValue` is entered by an admin (form or CSV) with a URL or "entered by admin" source. No evidence; four fictional sample products. | Values are extracted from manufacturer pages with a verbatim evidence quote and reviewed one by one. Manual entry goes away (D8). |
| Fetching | Nothing is fetched; Phase A had no scraping at all. | A fetcher with an allow-list, robots.txt and rate limits enforced in code (D6). |
| Approval UI | The PR #13 board: two zones, five ordered slots, keyboard and screen-reader support. | Reused for the lever step, with a coverage count on each card (D9). |

## 2. Decisions

### D1. Taxonomy rules

- **Two kinds of node.**
  - **Navigation** nodes have children, an explainer and no levers or products.
  - **Decision** nodes are leaves, with five published levers and a product list.
- **One primary parent** (`parentId`, null only for roots), which drives breadcrumbs. **Optional secondary parents** ("also listed in") list the node under other navigation nodes.
- **Parents are navigation nodes.** A decision node never has children.
- **No cycles.** Primary and secondary edges together form a DAG. Three layers enforce it:
  - the API checks first, for a friendly 400 that names the path;
  - a database trigger refuses any insert or update of `parentId` or of a secondary edge that would make a node its own ancestor. It walks both edge types with a recursive CTE.
  - Both run under a lock on the taxonomy (`pg_advisory_xact_lock` on a fixed key), so two concurrent edits cannot each pass and together form a cycle.
- **Slugs are globally unique** and URLs stay `/categories/:slug` (Q8). Breadcrumbs come from the primary path.
- **Safety flag inherited.**
  - `TaxonomyNode.safetyCritical` is set on Car seats.
  - A decision node is safety-critical if any primary ancestor is.
  - Every lever on a safety-critical node is safety-flagged, whatever its shared definition says, so all car-seat levers are flagged (spec, "Publish gate").
- **Visibility.**
  - A decision node is public when published (D10).
  - A navigation node is public when its explainer is approved and at least one descendant decision node is published.
  - Unpublished nodes are hidden from browse. Search still finds them and says they are being prepared (Phase A rule).

### D2. Schema

New enums:
- `NodeKind { NAVIGATION, DECISION }`
- `CatalogStatus { PROPOSED, APPROVED, REJECTED }` (products)
- `ValueStatus { PROPOSED, ACCEPTED, REJECTED }`
- `Confidence { HIGH, MEDIUM, LOW }`
- `RunStage { PLACE, LEVERS, DISCOVER, EXTRACT }`
- `StageStatus { PENDING, RUNNING, DONE, FAILED, STALLED, WAITING }`
- `RunStatus { ACTIVE, READY_FOR_REVIEW, STALLED, FAILED, CANCELLED, PUBLISHED }`
- `RunKind { NODE, EXPLAINER }`
- `FetchOutcome { OK, ROBOTS_DISALLOWED, NOT_ALLOWED, HTTP_ERROR, BLOCKED, UNSUPPORTED_TYPE, TOO_LARGE, NETWORK }`
- `AcceptMode { SINGLE, BULK }`

Phase A enums `LeverType`, `LeverInputFormat` and `LeverOrigin` stay. `LeverOrigin` gains `REFERENCE`.

**TaxonomyNode** (`taxonomy_nodes`; the Phase A `categories` table renamed, ids kept)

| Field | Notes |
|---|---|
| `id`, `slug` (unique), `name`, `searchTerms`, timestamps, `createdById` | as Phase A |
| `kind` | `NodeKind` |
| `parentId` | primary parent; a FK, `ON DELETE RESTRICT` |
| `position` | order among siblings |
| `safetyCritical` | bool. Set on Car seats; inherited by descendants (D1). |
| `explainer`, `explainerApprovedAt`, `explainerApprovedById` | navigation only (CHECK: null on decision nodes). Written by an `EXPLAINER` run and approved by an admin (D5.7). |
| `publishedAt`, `publishedById` | decision nodes: set by the atomic publish (D10). Navigation nodes: not used; visibility is derived (D1). |

**NodeSecondaryParent** (`node_secondary_parents`): `(nodeId, parentId)` primary key, `createdById`, `createdAt`. The cycle trigger covers it (D1).

**LeverDefinition** (`lever_definitions`): the attribute, defined once and shared by sibling nodes.

| Field | Notes |
|---|---|
| `id`, `name` (unique on the normalized name), `type`, `inputFormat`, `unit` (canonical; D7), `explanation`, `relatedNeeds`, `allowedValues` | Phase A lever fields; the same CHECKs (unit iff measurement, dimensions iff cu ft) |
| `safetyFlag` | bool, for a definition that is safety-relevant anywhere |
| `origin`, `createdById`, `createdAt`, `editedById`, `editedAt` | |

Editing a definition used by a published node does not change the public page until that node is republished. Public reads go through the published copy on `NodeLever` (below).

**NodeLever** (`node_levers`): a definition's place on one decision node (the Phase A lifecycle).

| Field | Notes |
|---|---|
| `id`, `nodeId`, `definitionId` | `@@unique([nodeId, definitionId])` |
| `status` | `CANDIDATE` / `APPROVED` / `RETIRED` (Phase A meanings: approved = published) |
| `position` | 1–5 exactly when `APPROVED`; `@@unique([nodeId, position])` |
| `safety` | definition flag OR the node is safety-critical. A trigger keeps it true on safety-critical nodes. |
| `origin` | `GENERATED`, `ADMIN` or `REFERENCE` (the Phase A stroller set, D3) |
| `runId` | the run that proposed it |
| `published` | a JSON snapshot of the definition taken at publish: name, type, unit, explanation, allowed values. Public pages read this, so a later definition edit is not public until republish. |
| `approvedById/At`, `retiredById/At` | |

Phase A's deferred constraint trigger moves here: at commit, a node has exactly 0 or 5 `APPROVED` levers.

**Product** (existing table; changes only)

| Field | Notes |
|---|---|
| `categoryId` renamed **`nodeId`** | must be a decision node (trigger); null means unplaced (hidden from node lists) |
| `category` (string) | kept equal to the node's slug: the ML service reads it (backlog #19) |
| `catalogStatus` | `PROPOSED` (discovered by a run), `APPROVED`, `REJECTED`. Existing rows become `APPROVED`. |
| `manufacturerUrl` | https only. Required for products a run discovers. |
| `discoveredByRunId`, `reviewedById`, `reviewedAt` | |
| `listed` | bool, written only by the publish transaction: shown in the node's public list |
| `isDryRun` | true for products created by a dry-run run (D11) |

- **ProductAlsoListedIn** (`product_also_listed_in`): `(productId, nodeId)`, decision nodes only, never the product's own node.
- **Bundles later:** a future `ProductBundleItem(bundleId, productId, quantity)` table works with this shape. Nothing here assumes a product is atomic, and nothing is built now.
- Product pages for `PROPOSED` and `REJECTED` products are 404 publicly. Pages for existing user-added products are unchanged.

**ProductLeverValue** (existing table, reshaped)

| Field | Notes |
|---|---|
| `productId`, `definitionId` (was `leverId`) | `@@unique([productId, definitionId])`: one current value. A product is in one node, so this is per node. |
| typed value columns | as Phase A (`valueNumber`, `valueText`, `valueBool`, `valueList`, `dim*`, `isUnknown`) |
| `statedValue`, `statedUnit` | exactly as the page states them, before conversion (D7) |
| `status` | `PROPOSED` / `ACCEPTED` / `REJECTED` |
| `evidenceQuote` | ≤ 300 chars. The code checked it verbatim against the fetched text at extraction (D7). |
| `sourceUrl` | the page the quote came from |
| `confidence` | the model's rating, lowered by code rules (D7) |
| `unknownReason` | `not_stated`, `quote_not_found`, `number_not_in_quote`, `unit_unknown`, `page_not_fetched`, … |
| `runId`, `extractedAt` | |
| `reviewedById`, `reviewedAt`, `acceptMode` | who accepted or rejected it, when, and whether one by one |
| `editedById`, `editedAt` | when an admin corrected the value (not the quote) |
| `published` | bool, written only by the publish transaction |

Removed: `sourceType`, `sourceLabel`, `isSample`, `recordedBy*`. Manual entry is gone (D8), and migrated rows keep their old source in `statedValue` and `unknownReason='phase_a_admin_entered'` (D3).

**CHECKs and triggers** (raw SQL; `migrate diff` ignores them, as in Phase A)
1. An `ACCEPTED`, not-unknown value has `evidenceQuote` and an https `sourceUrl`.
2. An unknown value has every value column null.
3. A trigger refuses an `ACCEPTED` value with `acceptMode = BULK` whose node lever is safety-flagged. This backs the API rule in D9 at the database.
4. `ACCEPTED` and `REJECTED` require `reviewedById` and `reviewedAt`.

**GenerationRun** (`generation_runs`)
- `id`, `nodeId`, `kind`, `mode` (`LIVE`/`DRY_RUN`), `status`, `createdById`, `createdAt`, `finishedAt`
- `notes` (≤ 1,000 chars)
- `model`
- `capUsd` (the per-run cap when it started)
- `costUsd` (the sum of its calls)
- `estimateUsd` (shown before start)
- `error`

**GenerationRunStage** (`generation_run_stages`): `(runId, stage)` unique.
- `status`, `attempts`, `startedAt`, `heartbeatAt`, `finishedAt`, `error`
- `output` (validated JSON of what the stage produced)
- `itemsTotal`, `itemsDone`: extraction progress, one item per product.

**GenerationCall** (`generation_calls`): the cost ledger.
- `runId`, `stage`, `productId?`, `model`, `servedModel`, `status`
- `reservedUsd` (worst case, written before the call)
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `webSearches`, `costUsd` (actual, written after)
- `createdAt`

Caps are computed from this table (D5.6).

**ExtractionItem** (`extraction_items`): `(runId, productId)` unique.
- `status` (`PENDING`/`RUNNING`/`DONE`/`FAILED`)
- `fetchOutcome`, `httpStatus`, `fetchedAt`
- `attempts`, `error`

**FetchedPage** (`fetched_pages`): `url`, `productId`, `runId`, `text` (extracted, ≤ 400k chars), `contentHash`, `fetchedAt`, `expiresAt` (= `fetchedAt` + 24 h). Deleted by the purge job (D6).

**ManufacturerDomain** (`manufacturer_domains`): the allow-list.
- `host` (unique, lower-case, no `www.`; D6), `approvedById`, `approvedAt`
- `viaProductId`: the product whose approval added it
- `lastFetchAt`: the per-domain rate limiter's clock
- `robotsTxt`, `robotsFetchedAt`, `robotsStatus`: cached for 24 h

**Survey** (`survey_imports.categoryId` renamed `nodeId`; decision nodes only). Otherwise unchanged.

**Phase A tables**
- `value_levers` is migrated into `lever_definitions` and `node_levers`, then dropped (D3).
- `lever_candidate_runs` stays as read-only history. It is shown on the node's admin page and not counted against the new caps.

### D3. Migration from Phase A

Small, isolated migrations, each applied with `migrate deploy`, in this order:

1. **`taxonomy_nodes`**
   - Rename `categories` to `taxonomy_nodes` and `products.categoryId` to `nodeId`.
   - Add `kind`, `parentId`, `position`, `safetyCritical`, the explainer fields, `publishedAt/ById` (from `leversPublishedAt/ById`), `node_secondary_parents`, and the cycle and parent-kind triggers.
2. **`launch_taxonomy`**: a data migration, idempotent by slug (`INSERT … ON CONFLICT (slug) DO UPDATE`).
   - It creates the launch taxonomy as unpublished nodes (D4). The rows are product structure every environment needs, not demo data, so they belong in a migration rather than the seed.
   - The existing `strollers` and `car-seats` rows are reused (same ids) as the Strollers and Car seats navigation nodes.
3. **`lever_definitions`**: create `lever_definitions` and `node_levers`, then move the data:

   | Phase A rows | What happens |
   |---|---|
   | The five published `strollers` levers | Become shared `LeverDefinition`s (origin `ADMIN`), plus `NodeLever` rows on **Full-size strollers** with `status = CANDIDATE`, `origin = REFERENCE`. This is my recommendation, matching your preference and the spec ("a reference input to the Full-size strollers run"). They appear on the board badged "Reference (Phase A)", are sent to the run's lever stage as input (D5.2), and get coverage counts from extraction like any candidate. Nothing about them is published. |
   | `car-seats` candidate levers from a test run | Kept as history only. Car seats is now a navigation node, so they get no `NodeLever` rows. They stay readable in `lever_candidate_runs.output`, which the node's History section shows. The `value_levers` rows are dropped with the table. |
   | Levers of any other category (kitchen etc.) | Become definitions plus `CANDIDATE` node levers on the same node. Every published set is unpublished: the new gate needs evidence that Phase A values do not have. |

4. **`product_lever_values_v2`**: reshape values (D2).
   - Delete the **fictional sample products**: every product whose lever values are all `isSample` and that has no review threads. That matches exactly the four seeded strollers ("Breeze City Compact" and the others).
     - The criterion is data-based, not name-based, so it cannot delete a real product with reviews.
     - The seed stops creating them.
   - Remaining Phase A values (admin-entered, on real products) become `PROPOSED` and unknown, with the old value text in `statedValue` and `unknownReason = 'phase_a_admin_entered'`. They have no evidence quote, so they can never pass the gate; extraction replaces them.
5. **`generation_runs`**: the run, stage, call, extraction-item, fetched-page and manufacturer-domain tables.
6. **Products**:
   - add `catalogStatus` (existing rows `APPROVED`), `manufacturerUrl`, `listed`, `isDryRun`, the review fields, and `product_also_listed_in`;
   - unplace products whose node became a navigation node: `nodeId = null`, listed on the admin "Unplaced products" page so an admin can move each into a decision node.

**What becomes of each Phase A category**
- `strollers` and `car-seats` become navigation nodes under Baby and Kids.
- `kitchen`, `furniture`, `home` and `outdoor` become root-level decision nodes. They are unpublished and hidden, and their products and reviews are untouched (Q7).

**Seed changes**
- `seedLevers.ts` becomes `seedCatalog.ts`.
- It keeps the dev/test admin.
- It stops creating sample products and publishing stroller levers.
- `npm run db:seed:levers` is renamed `db:seed:catalog`; the old name stays as an alias for one release.

### D4. Launch taxonomy (seeded unpublished, D3 step 2)

```
Baby and Kids                                   navigation
├── Car seats  (also listed in Seats)           navigation, safetyCritical
│   ├── Infant car seats                        decision
│   ├── Convertible and all-in-one car seats    decision
│   └── Booster seats                           decision
└── Strollers                                   navigation
    ├── Full-size strollers                     decision   (+ the Phase A reference levers)
    ├── Travel strollers (incl. umbrella)       decision
    ├── Jogging strollers                       decision
    └── Double strollers                        decision
Seats                                           navigation (root; exists so "also listed in" has a parent)
```

- **Slugs:** `baby-and-kids`, `car-seats`, `infant-car-seats`, `convertible-car-seats`, `booster-seats`, `strollers`, `full-size-strollers`, `travel-strollers`, `jogging-strollers`, `double-strollers`, `seats`.
- **Search terms:** from the spec, for example "umbrella stroller" on Travel strollers and "all-in-one car seat" on Convertible.
- **Explainers** start empty. An `EXPLAINER` run writes one per navigation node and an admin approves it (D5.7).
- **Generation order** is a UI hint: the travel-system pair (Infant car seats, then Full-size strollers) is listed first.

### D5. The run pipeline

**Trigger.**
- `POST /api/admin/nodes/:id/runs { notes? }` on a decision node shows the estimate and the caps.
- The handler validates the node, reserves nothing yet, inserts the run with its four stages `PENDING` and answers **202**.
- Work continues in-process (the Phase A pattern; no Redis).
- One active run per node (a partial unique index on `generation_runs(nodeId) WHERE status IN ('ACTIVE','STALLED')`).

**Stages** (each writes its own output, so any stage can be re-run or resumed without repeating earlier ones):

1. **PLACE.** One call. Claude gets the node's name, primary path and the whole taxonomy outline (names and slugs only).
   - It returns whether the primary parent fits, any proposed secondary parents (existing navigation slugs only), and the search terms to add.
   - Validated by zod and by the same cycle check as D1.
   - Shown in the review screen as suggestions; nothing applies until an admin accepts. For the seven seeded nodes this is a quick confirmation.
2. **LEVERS.** One call. Input:
   - the node and path;
   - all existing `LeverDefinition`s (name, type, unit, explanation): the reuse catalogue;
   - the node's `REFERENCE` levers;
   - the admin's notes;
   - the supported canonical units (D7).

   Output: 10–12 candidates. Each either reuses a definition id or defines a new one (Phase A fields plus `safetyFlag`).
   - The Phase A strict zod rules apply: count, unit iff measurement, one-line explanations, unique names.
   - A new definition whose normalized name matches an existing one is folded into the existing one.
   - An unknown reuse id fails the stage (`validation_failed`).
   - Reference levers count toward the 10–12 when Claude keeps them; Claude may also say why one should be dropped (shown on its card).
3. **DISCOVER.** One call with Claude's **web search tool** (D6.1), `max_uses` 8. It returns 15–20 widely sold products, each with brand, model name and manufacturer product-page URL.
   - The URL must be https on a host that is not on the retailer/review denylist (D6.3) and not a duplicate. The product name must not match an existing product in another node (that is flagged for the admin instead).
   - Matching existing products (same normalized brand + name, or the same URL) are linked, not duplicated.
   - Products are stored as `PROPOSED`. Nothing is fetched from them yet: their domains are not on the allow-list until an admin approves the product.
   - The stage then sets the run to `READY_FOR_REVIEW` (product review) and notifies the admin (Q13).
4. **EXTRACT.** One item per approved product, queued when the admin approves it. So product review and extraction overlap: values start arriving while the admin is still approving products.
   - Per item: fetch the manufacturer page (D6), extract text, then one Claude call covering **every** candidate lever (spec: one fetch per product covers all candidate levers), then validate in code (D7) and store `PROPOSED` values.
   - Each item is idempotent: a re-run replaces that product's `PROPOSED` and `REJECTED` values and never touches `ACCEPTED` ones (Q15).
   - Concurrency: two items at a time, but never two for the same domain (the rate limiter, D6.4).

**Run states.**
- `ACTIVE` while any stage runs.
- `READY_FOR_REVIEW` once DISCOVER is done.
- `STALLED` if a stage stops heartbeating.
- `FAILED` on a validation or API failure (the stage keeps its error; **Resume** retries that stage).
- `PUBLISHED` after a publish.
- `CANCELLED` by an admin.

**5.5 Stuck-run detection.**
- Each stage writes `heartbeatAt` before and after every call and fetch.
- A reconciler runs at startup and every minute. It marks a `RUNNING` stage whose heartbeat is older than 10 minutes as `STALLED`. The API timeout is 4 minutes with 1 retry, so a live call always heartbeats inside that window.
- **Resume** (an admin button, Q17) restarts the stage from the first unfinished item.
- Work is claimed with `UPDATE … SET status='RUNNING' WHERE status IN (…) RETURNING`, so two processes never run the same stage or item.

**5.6 Cost controls.**

| Control | How |
|---|---|
| Per-run cap | `GENERATION_RUN_CAP_USD` (default 10), copied onto the run at start |
| Per-day cap | `GENERATION_DAILY_CAP_USD` (default 40), rolling 24 h, all runs and admins |
| Enforcement | Before every API call, under a Postgres advisory lock, insert a `GenerationCall` with `reservedUsd` = worst case. That is input tokens counted locally (prompt length ÷ 3, rounded up) at the input price, plus `max_tokens` at the output price, plus `max_uses` × $0.01 for searches. It is refused if (run spend + reservation) > run cap, or (24 h spend, using actual cost or the reservation when no actual exists yet, + reservation) > daily cap. After the response, write the actual tokens and cost. |
| Over a cap | The stage stops cleanly as `STALLED` with `error: run_cap` or `daily_cap`. It resumes from the next item once the cap allows (raise the env var, or wait). Nothing already extracted is lost. |
| Estimate | Shown before start and stored on the run: about $2.70 per node at defaults (below). |
| Pricing | `levers/pricing.ts` moves to `generation/pricing.ts`, adding web search at $10 per 1,000. Unpriced models use the requested model's price, else the cost is null and the call is refused in live mode, since a cap cannot be enforced on an unknown price. |
| Dry run | Default in dev and CI (D11). Cost 0, no network. |
| Tests | `tests/setupEnv.ts` pins dry run. The real client refuses `NODE_ENV=test`, as in Phase A. |

**Cost estimate per decision node** (Claude Opus 5.5 at $4 / $20 per million input/output tokens; web search $10 per 1,000; checked on the Claude docs 2026-11-20):

| Stage | Assumption | Cost |
|---|---|---|
| PLACE | 2k in, 2k out (effort `high`) | $0.05 |
| LEVERS | 5k in, 10k out (effort `high`) | $0.22 |
| DISCOVER | 8 searches; about 60k in (results stay in context), 12k out | $0.56 |
| EXTRACT | 18 products × (14k in: page capped at 12k tokens + lever block; 2.5k out at effort `medium`) | $1.91 |
| **Total** | | **≈ $2.70** (range $2–5: page size, re-runs) |

- Seven nodes cost about $20–35.
- Navigation explainers cost about $0.05 each.
- The defaults ($10 per run, $40 per day) allow one node plus a re-run per day with margin.

**5.7 Explainer runs** (`kind = EXPLAINER`, navigation nodes):
- One stage, one call. Input: the node and its children's names.
- Output: a ≤ 600-character explainer of how the children differ, plus one line per child.
- An admin edits and approves it on the node page; that sets `explainerApprovedAt`.
- Cost and caps as above.

**5.8 Model calls** (shared rules, `generation/client.ts`; extends `levers/client.ts`):
- `@anthropic-ai/sdk` 1.5.0 (already a dependency), model `ANTHROPIC_MODEL` (default `claude-opus-5-5`), adaptive thinking.
- Effort: `high` for PLACE, LEVERS and DISCOVER; `medium` for EXTRACT (Q11).
- No refusal fallback; a refusal fails the call (Phase A Q7). Non-streaming, `max_tokens` ≤ 21000, a 4-minute timeout and 1 retry (Phase A).
- **Output format:**
  - PLACE, LEVERS, EXTRACT and EXPLAINER use `output_config.format` (a JSON schema) plus our strict zod validation.
  - DISCOVER cannot: web search results always carry citations, and the API rejects citations with `output_config.format`. It returns its list through a strict client tool (`propose_products`, `strict: true`, `tool_choice: auto`, since forced tool choice is a 400 on Opus 5.5).
  - The code reads the tool input from the response and does not continue the conversation; `pause_turn` (the server search loop limit) is resumed up to 3 times. If the model ends without calling the tool, the stage fails with `no_result`.
- **Prompt injection:** fetched page text is untrusted.
  - It is sent inside a clearly delimited document block in the user turn, with the instruction to extract only the listed attributes.
  - The model's output is data, validated by zod and the evidence checks (D7).
  - Nothing it returns is executed, followed as a URL (EXTRACT returns no URLs), or rendered as HTML.

### D6. Fetching and the data sourcing rules

**6.1 Claude's web tools vs. fetching ourselves.** Checked on the Claude docs (`platform.claude.com/docs`, the web search, web fetch, server tools and structured outputs pages, 2026-11-20):

- **Support.** Both tools support `claude-opus-5-5`. Current versions are `web_search_20260318` and `web_fetch_20260318`, with dynamic filtering. `allowed_callers: ["direct"]` turns filtering off.
- **Pricing.** Web search is $10 per 1,000 searches plus tokens. Web fetch has no charge beyond tokens.
- **Domains.** Both take `allowed_domains` or `blocked_domains` (not both; subdomains included).
- **Web fetch specifics.**
  - It refuses `robots.txt`-disallowed URLs on Anthropic's side (`url_not_allowed`).
  - It fetches only URLs already in the conversation.
  - It caches pages (`use_cache: false` bypasses).
  - It does no JavaScript rendering.
  - It returns the page text in a `web_fetch_tool_result` document.

| Requirement | Claude web fetch | Our own fetcher |
|---|---|---|
| Allow-list, enforced in code | `allowed_domains` per request (the API enforces it; we pass the list) | checked before every request and every redirect hop |
| robots.txt respected | yes, Anthropic-side; not inspectable or testable here | parsed and enforced by us; tested with mocked HTTP |
| 1 request/second per domain | no control | DB-clocked limiter (6.4) |
| No logins or block bypass | yes | yes (6.5) |
| Evidence quote verbatim in fetched text, checked in code | possible (the text comes back with `allowed_callers: ["direct"]`) | yes, against the exact text we extracted |
| Unknown never guessed | prompt plus code checks either way | same |
| No images | text, HTML and PDF only | we request and keep text only |
| Fetched text deleted within 24 h | our copy, yes; Anthropic's cache and retention are theirs | yes (6.6) |
| Fresh content | cached unless `use_cache: false` | always fresh |
| Tests with HTTP mocked | only the API can be mocked; the rules live outside our code | every rule unit-tested and mutation-checked |
| Cost | tokens only | tokens only (we also strip navigation and cap the text, so fewer tokens) |

**Recommendation (Q1):**
- **Extraction fetches manufacturer pages ourselves.** Most of the required rules (rate limit, testable robots.txt, freshness, 24 h deletion) cannot be guaranteed or tested through the server tool.
- **Discovery uses Claude's web search tool**, which reads search results and fetches no site. Its `blocked_domains` lists the denylist (6.3), and its results only propose products: nothing is fetched until an admin approves a product.
- **Web fetch is not used.**

**6.2 Allow-list.**
- A host is added to `manufacturer_domains` **only when an admin approves a product** whose `manufacturerUrl` is on it, in the same transaction as the approval. The review screen says "Approving adds `example-brand.com` to the allow-list".
- Hosts are stored lower-case without a leading `www.`; `www.x.com` and `x.com` are treated as the same host. Other subdomains are distinct (Q2).
- Before every request, including robots.txt and every redirect hop, the fetcher checks the host is on the list. A redirect off the list stops with `NOT_ALLOWED`.
- Removing a domain (admin) stops future fetches; values already extracted stay for review.

**6.3 Denylist.**
- A fixed list in code of retailers and review sites never allowed even with approval, for example amazon., walmart., target., babylist., buybuybaby., yelp., ebay., bestbuy., reddit., consumerreports.
- Approving a product whose URL is on it is a 400 that tells the admin to find the manufacturer page.
- Defence in depth for "retailers and review sites are excluded".

**6.4 robots.txt and rate limit.**
- **robots.txt:**
  - Fetched per host (it counts against the rate limit) and cached in `manufacturer_domains` for 24 h.
  - Parsed with `robots-parser` for our product token `VerdictBot`.
  - Per RFC 9309: a 4xx means allow all; a 5xx, a network error or a redirect loop means disallow all until the next refresh.
  - A disallowed URL becomes `ROBOTS_DISALLOWED`: no request is made, and every lever is unknown with `page_not_fetched`.
  - A `Crawl-delay` above 1 s is honoured.
- **Rate limit:** 1 request per second per host (across instances).
  - Before each request, lock the host's `manufacturer_domains` row (`SELECT … FOR UPDATE`), wait until `lastFetchAt + max(1 s, crawl delay)`, set `lastFetchAt = now()`, commit, then send.
  - Sleeping happens outside the transaction; the lock is held only to claim the slot.

**6.5 Request rules.**
- `GET` only.
- `User-Agent: VerdictBot/1.0 (+<FRONTEND_URL>/bot)`; a short public `/bot` page says what it fetches and how to opt out (robots.txt).
- `Accept: text/html,application/xhtml+xml`.
- No cookies kept (no cookie jar) and no credentials.
- At most 5 redirects, each re-checked against the allow-list and robots.txt.
- 15 s timeout; 3 MB body cap (`TOO_LARGE`).
- A content type other than HTML is `UNSUPPORTED_TYPE` (PDF manuals are Q4).
- **401, 403, 429, or a page that looks like a challenge** (`cf-mitigated` header, a "captcha" form): the item stops as `BLOCKED`.
  - No retry with other headers, no proxy, no headless browser.
  - The host is paused for 24 h (`robotsStatus = blocked`).
- 5xx and network errors are retried once after 30 s.
- Node 22's built-in `fetch` is used (no new HTTP dependency).

**6.6 Text extraction, images and retention.**
- **HTML to text** with `htmlparser2`:
  - `script`, `style`, `noscript`, `svg`, `img`, `picture`, `video`, `iframe`, `nav`, `footer` and form controls are dropped;
  - block elements and table cells become line breaks or ` | `, so spec tables stay readable;
  - whitespace is collapsed and the text normalized with NFKC.
- **No images.** No image URL is followed or stored, and `Product.imageUrl` is never set by the pipeline.
- **Retention.** The text is stored in `fetched_pages` with `expiresAt` = 24 h.
  - Every read filters `expiresAt > now()`.
  - A purge job (startup plus every 15 minutes, inside the existing reconciler interval) deletes expired rows.
  - Only the short evidence quotes outlive it.
  - The 12k-token excerpt sent to Claude is the first part of that same text (spec tables are usually near the top; when the text is longer, the page's spec-table section is preferred if one is found).

### D7. Evidence and value validation (in code, after the model)

The model returns, per candidate lever:
- `found` (bool)
- `statedValue` (string, as written)
- `statedUnit`
- `quote` (≤ 300 chars)
- `confidence`
- for list and dimension levers, the parts.

Code then applies these rules in order. The first failure makes the value **unknown** with a reason; nothing is ever filled in from elsewhere.

1. `found = false` gives unknown (`not_stated`).
2. **Verbatim quote:** the quote, after the same NFKC and whitespace normalization as the page text, must be a substring of the fetched text. Case and punctuation must match. Otherwise `quote_not_found`.
3. **The value must be in the quote:**
   - **Measurements:** the number (as written: `9.1`, `20`, `20.5`) must appear in the quote as a whole number token.
   - **Dimensions:** all three numbers.
   - **Lists:** every item as a whole phrase (case-insensitive).
   - **Categories:** the model maps to an allowed value. Code cannot prove that mapping, so confidence is capped at `MEDIUM`.
   - **Booleans:** "no" needs an explicit statement in the quote. A missing feature is unknown, never "no".
   - Otherwise `number_not_in_quote` / `item_not_in_quote`.
4. **Units.** `statedUnit` is converted to the definition's canonical unit with a fixed table, or the value is unknown with `unit_unknown`:
   - mass: kg, g, lb, oz → lb
   - length: mm, cm, m, in, ft → in
   - volume: L, cu in, cu ft → cu ft
   - Conversion rounds to 2 decimals; `statedValue` and `statedUnit` keep the original.
   - A converted value's confidence is capped at `MEDIUM` only when the page states the canonical unit nowhere else in the quote.
5. **Type shape.** The Phase A `toValueData` rules: allowed values, a positive finite number, dimensions with a computed volume.
6. **Plausibility.** A definition may carry `minValue`/`maxValue`. Out of range is kept as `PROPOSED` with confidence `LOW`, never dropped silently.

The model's `confidence` can only be lowered by code, never raised. "Low confidence" in the review filter means `LOW`, or any value whose unit was converted from a unit the quote does not otherwise contain.

### D8. What is removed from Phase A

- **The admin value form and the value CSV import.**
  - The spec says a run produces values "with no manual data entry", and every published value needs a source link and an evidence quote.
  - An admin can still **edit** an extracted value (for example a misread unit), but not the quote or the URL. An edited value records who, when and the original, and stays `PROPOSED` until accepted.
  - Keeping manual entry with a pasted quote is Q20.
- **The run-count daily limit** (`LEVER_GEN_DAILY_LIMIT`), replaced by the cost caps.
- **`isSample`**, and "Sample data" in the UI.

### D9. Review screen (desktop-first; mouse and keyboard)

`/admin/nodes/:id/review`. One page with three steps in a left rail (Products, Levers, Values), each showing progress counts.
- Only the active run's data appears.
- Every action writes who and when.
- Every list uses the existing patterns: real buttons, a visible focus ring, live-region announcements for actions.
- Shortcuts are shown on the page, are single letters only when the focus is in the grid or list (not in a text field), and `?` lists them.

**Products.**
- A table: name, brand, manufacturer host, URL (opens in a new tab), match notes ("same as an existing product in Jogging strollers"), status.
- `J`/`K` or arrows move; `A` approves, `R` rejects, `U` undoes.
- Multi-select with Shift for bulk approve or reject. Products are not values, so bulk is allowed.
- Approving shows the host that joins the allow-list and queues extraction for that product (D5.4).
- Counts: approved / rejected / pending, and extraction progress with fetch outcomes ("17 extracted, 1 robots.txt disallowed, 1 blocked (403)").

**Levers.**
- The PR #13 `PublishBoard`, unchanged in behaviour.
- Each card adds:
  - **coverage:** "18 of 20", the approved products with a known value (proposed or accepted). It turns amber below 80%. A second line shows accepted coverage once review starts.
  - a **Safety** badge;
  - a **Reference (Phase A)** badge;
  - a **Shared with: Jogging strollers** note when the definition is used elsewhere.
- Edit and Retire stay. Editing a shared definition warns that it changes the definition for every node using it (public only on republish).
- Candidates sort by coverage, then the run's order.

**Values.**
- **Layout:** a grid of approved products (rows) by the chosen five (columns), ARIA `grid` with roving focus.
- **Cells** show the converted value or "Unknown", a status mark (proposed, accepted, rejected, edited) and a low-confidence dot.
- **Evidence panel** (right side) for the focused cell: stated value and unit, converted value, the quote with the value highlighted, the source link, confidence, unknown reason, and edit history.
- **Keys:**
  - arrows move;
  - `A` accept, `R` reject, `U` mark unknown, `E` edit;
  - **Enter is accept-and-next**: it accepts, then moves to the next unreviewed cell in reading order;
  - `N` next unreviewed.
- **Filters:** unreviewed, unknown, low confidence, safety levers, one product, one lever.
- **Progress:** per column, accepted known values / approved products, with the gate (80%) marked; overall reviewed / total.
- **Bulk accept** (a column's high-confidence proposed values) exists only for non-safety levers. On safety levers it is disabled with the reason "Safety lever: review each value". The API refuses it too (400), and the database trigger refuses `acceptMode = BULK` on a safety lever (D2).
- **Locking.** A value accept locks the node row and re-reads the value, like Phase A writes, so a re-extraction cannot overwrite a value mid-review.

**Admin node pages.** `/admin/nodes` shows the taxonomy tree:
- kind, published or not, the active run, status and cost;
- the launch order hint;
- unplaced products.

The node page has a run history: new runs with stages, cost per stage and errors, then Phase A runs as read-only history.

### D10. Publish gate and atomic publish

`POST /api/admin/nodes/:id/publish { leverIds: [5, in order] }`, in one transaction:

1. Lock the node row.
2. Check the node is a decision node with no active run stage (`RUNNING` extraction would race).
3. Check exactly five distinct non-retired levers of this node, with Phase A's rules (allowed values on category levers).
4. Check at least `GENERATION_MIN_PRODUCTS` (default 10, Q10) approved products.
5. **The gate:** for each of the five, the count of approved products with an `ACCEPTED`, known value must satisfy `accepted × 5 ≥ approved × 4` (integer arithmetic, so 80% exactly passes).
   - An accepted "unknown" does not count (Q9).
   - The 400 lists each failing lever with its coverage ("Weight: 14 of 20 (70%)").
6. **Write the published state:**
   - The five become `APPROVED` with positions and a published snapshot; the previous five, if any, become `RETIRED`.
   - `listed = true` on approved products; `false` on every other product of the node.
   - `published = true` on accepted values of the five levers for listed products; `false` on all other values of the node's products.
   - Set `publishedAt/ById`; the run becomes `PUBLISHED`.
7. At commit, the deferred trigger checks 0 or 5 approved levers.

Public reads use only `listed` products, `published` values and `APPROVED` node levers' snapshots, through one module (`catalog/public.ts`, the successor of `publicLevers()`). Anything changed after a publish (a new accept, an edit, a new product) is invisible until the next publish. A listed product with no published value for a lever shows "Unknown", matching the spec's explicit unknown.

**Unpublish:** `POST /api/admin/nodes/:id/unpublish` clears the same flags in one transaction.

### D11. Dry run (default in dev and CI)

`GENERATION_MODE=dry_run` (Q16):
- **Stages use fixtures** in `generation/fixtures/`: placement, levers, products and extraction answers for the seven launch nodes. Infant car seats is complete; the others are generic and built from the node name.
- **Fixture products** are fictional brands on reserved `.example` hosts (`https://www.lullacarry.example/products/…`).
- **Fixture fetcher.** Fetches go through the **same fetcher with a fixture transport** that serves `generation/fixtures/pages/*.html` and fixture `robots.txt` files. So the allow-list, robots.txt, the rate limiter, text extraction, the verbatim check and unit conversion all run for real; only the network is replaced.
- **Deliberate failures:** the Infant car seats fixtures include
  - a host whose robots.txt disallows the product path;
  - a page that answers 403;
  - an extraction answer with a paraphrased quote, which must be rejected as `quote_not_found`;
  - values in kg and cm, which must be converted;
  - a feature not mentioned, which must be unknown, not "no".
- **No API calls.** Cost is 0, `mode = DRY_RUN`, and products have `isDryRun = true`.
- **Publishing dry-run data** is allowed only when `NODE_ENV` is `development` or `test`, and public pages show "Dry-run data" on such products (Q14). In any other environment publish refuses a node with dry-run products.

### D12. Public side

- **Search** (`GET /api/search?q=`) matches nodes first, then products by name and brand (as now):
  - a navigation node returns its explainer and its published children;
  - a decision node links to its page;
  - an unpublished match says "being prepared".
- **Browse:** published decision nodes and visible navigation nodes only.
- **`/categories/:slug`:**
  - **Navigation node:** breadcrumbs, the explainer, and child cards (name, one-line difference, product count).
  - **Decision node:** breadcrumbs and the five levers as filters, each with its one-line explanation. Filters update the list without a reload (the Phase A `CategoryPage`, reading the published snapshot), and the list shows listed products only. Unpublished nodes are 404.
  - **"Also listed in":** the node appears under its secondary parents' child cards; a product also listed in another node appears in that node's list too, with its own node's levers linked.
- **Product page:** lever values with the source link and evidence quote ("From the manufacturer: '…'"), and the node's typical value. Unknowns are shown as unknown.
- **Phones:** the public pages above are built and browser-checked at 390 px (filters collapse into a "Filters" disclosure). Admin pages are desktop-only (≥ 1024 px), per your instruction.

### D13. API summary

**Admin** (auth + admin role):
- Nodes: `GET /admin/nodes` (tree), `GET /admin/nodes/:id`, `POST /admin/nodes`, `PATCH /admin/nodes/:id` (name, search terms, parent, secondary parents, explainer approve).
- Runs: `POST /admin/nodes/:id/runs`, `GET /admin/runs/:id` (stages, costs, progress), `POST /admin/runs/:id/resume`, `POST /admin/runs/:id/cancel`.
- Products: `POST /admin/products/:id/approve|reject`, `POST /admin/products/bulk`, `PATCH /admin/products/:id` (place in a node, also-listed-in).
- Values: `POST /admin/values/:id/accept|reject|unknown`, `PATCH /admin/values/:id` (edit), `POST /admin/nodes/:id/values/bulk-accept`.
- Publishing: `POST /admin/nodes/:id/publish|unpublish`.
- Domains: `GET/DELETE /admin/domains`.
- Phase A lever edit, retire and survey routes move from `categories` to `nodes`.

**Public:** `GET /api/search`, `GET /api/categories` (browse tree), `GET /api/categories/:slug`, `GET /api/products/:id` (extended).

### D14. Dependencies (backend)

- **`robots-parser`** 3.0.1 (MIT, no dependencies): robots.txt matching (wildcards, `$`, longest match, crawl-delay) is easy to get subtly wrong by hand.
- **`htmlparser2`** 12.x (MIT; 4 small dependencies of its own): a forgiving streaming HTML parser for text extraction. No DOM or CSS engine needed.
- No frontend dependencies (dnd-kit is already there). No headless browser (Q5).

### D15. Testing plan (Steps 2–4)

**Backend tests** run on real Postgres. The Anthropic client is injected and mocked. HTTP goes through an injected transport (mocked); no test reaches the network.

| Rule | Test | Mutation (must make a test fail) |
|---|---|---|
| Allow-list | Unapproved host → no request made, `NOT_ALLOWED`. Approving a product adds its host (www-equivalent). A redirect to another host stops. A denylisted URL can't be approved. | skip the host check; skip it on redirects; drop the denylist |
| robots.txt | Disallowed path → no page request, values unknown. 4xx robots → allowed; 5xx → disallowed. Cached for 24 h. | ignore the parse result; treat 5xx as allow |
| Rate limit | Two items on one host: the second request waits ≥ 1 s (fake clock). Crawl-delay honoured. | remove the wait |
| Blocks | 403 / 429 / challenge → `BLOCKED`, no retry, host paused | retry on 403 |
| Verbatim quote | A paraphrased quote → unknown `quote_not_found`. Whitespace and NFKC differences still match. Case differences don't. | replace the substring check with `includes` on lower case; skip the check |
| Unknown not guessed | `found=false` → unknown. Number not in quote → unknown. "No" without an explicit statement → unknown. | default a missing boolean to false; drop the number-in-quote check |
| Unit conversion | kg → lb, cm → in, L → cu ft, rounding. Unknown unit → unknown. | wrong factor; accept an unknown unit as canonical |
| Coverage gate | 15/20 (75%) refused with the lever named; 16/20 passes; an accepted unknown doesn't count | `>` vs `≥`; count unknowns |
| Atomic publish | A failure mid-transaction (injected) leaves nothing listed or published. Republish retires the old five and unlists rejected products. Public reads show only published rows. | write flags outside the transaction; read without the `listed` filter |
| No bulk accept on safety | Bulk accept including a car-seat lever → 400. A direct SQL update with `acceptMode=BULK` on a safety lever fails (trigger). Single accept works. Safety is inherited from Car seats. | drop the API check (trigger test holds); drop the trigger; drop inheritance |
| No cycles | Parent = own descendant (primary and via secondary) → 400. Direct SQL → trigger error. Concurrent edits can't form a cycle. A decision node can't be a parent. | drop the trigger; drop the API check; skip secondary edges in the walk |
| Caps | A reservation over the run cap → stage `STALLED run_cap` with no call. Daily cap across runs. Concurrent reservations at the limit → one passes. | remove the lock; count only actual cost |
| Stuck runs | A stale heartbeat → `STALLED`. Resume continues from the next item without re-calling finished ones. | resume from the start |
| Retention | Expired pages are not readable and are purged | drop the `expiresAt` filter |
| Model output | Each stage's malformed output fails the stage with nothing stored (Phase A style). Unknown reuse id. 14 or 21 products. | loosen the bounds |
| Migration | Phase A data (stroller levers, samples, car-seat run) migrates as D3 says. Sample products are gone; a product with reviews is kept. | |

**Frontend (Vitest):**
- coverage on board cards;
- value grid keyboard (accept-and-next, filters, bulk disabled on safety);
- navigation and decision public pages.

**Browser** (Playwright, dev servers, dry run):
- the full Infant car seats flow with **mouse** and with **keyboard only** on desktop;
- the public pages at 390 px.

**Then:**
- the reviewer agent over the full diff;
- the PR (screenshots in the description only);
- the dry-run transcript of Infant car seats end to end in the PR.

## 3. Out of scope (backlog)

- Claude proposing new child nodes; demand-driven search terms; "notify me when live".
- Bundles.
- PDF manuals (Q4); JavaScript-rendered pages (Q5).
- Review synthesis ("What expert reviewers say").
- Value history beyond the current value and its edit.
- Moving the ML service to `nodeId` (backlog #19).
- Projects and ranking (Phases B and C).

## 4. Open questions (recommended default in **bold**)

1. **Fetching:** **our own fetcher for manufacturer pages; Claude web search for discovery only; no Claude web fetch** (D6.1). Alternatives: Claude web fetch for pages (the rate-limit, testable robots.txt and freshness rules can't be met), or discovery from the model's knowledge without search (no search cost, but stale lists and invented URLs).
2. **Allow-list granularity:** **exact host, with `www.` and bare treated as one.** Or the registrable domain (all subdomains; needs the Public Suffix List, a dependency).
3. **Extraction timing:** **per product, as soon as an admin approves it** (the allow-list rule means nothing is fetched before approval). Or one batch after all products are reviewed.
4. **PDF manuals:** **deferred**; values only stated in PDFs come out unknown, and a node may then miss the gate. Adding them later means PDF text extraction (a dependency) and the same verbatim rules.
5. **JavaScript-rendered pages:** **no headless browser**; such pages give unknowns and show in the fetch outcome counts. Revisit if a launch node fails the gate because of it.
6. **Sample products:** **deleted in the migration** (all values sample, no reviews). Alternative: kept but hidden.
7. **Legacy categories** (kitchen, furniture, home, outdoor): **root-level unpublished decision nodes, hidden; their products and reviews untouched.** Or move them under new navigation nodes later.
8. **URLs:** **keep `/categories/:slug`**, breadcrumbs from the primary path. Or path URLs (`/c/baby-and-kids/strollers/…`), which change when a node moves.
9. **Coverage:** **an accepted "unknown" does not count toward 80%.** Counting it would let a node publish with no data on a lever.
10. **Minimum products to publish:** **10 approved** (the run targets 15–20). Or 15, the spec's discovery range.
11. **Effort:** **`high` for placement, levers and discovery; `medium` for extraction** (about half the extraction cost). Or `high` everywhere, about $4.50 per node.
12. **Caps:** **$10 per run, $40 per rolling day**, dry runs free.
13. **Ready-for-review notice:** **in-app** (an Admin nav badge and the run list) **plus one email to the admin who started the run**, through the existing transactional mailer. Or in-app only.
14. **Dry-run publish:** **allowed only in development and test, marked "Dry-run data".** Or never publish dry-run data (then the end-to-end transcript stops at review).
15. **Re-runs:** **never overwrite `ACCEPTED` values**; re-extraction replaces proposed and rejected ones.
16. **Env var names:** **`GENERATION_MODE`, `GENERATION_RUN_CAP_USD`, `GENERATION_DAILY_CAP_USD`, `GENERATION_MIN_PRODUCTS`**, with `LEVER_GEN_MODE` still read as an alias (with a warning) for one release. `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are unchanged; `LEVER_GEN_DAILY_LIMIT` goes away. `LEVER_GEN_MAX_TOKENS` becomes `GENERATION_MAX_TOKENS`.
17. **Stalled runs:** **manual Resume** (cost stays visible). Or auto-resume once at startup.
18. **Discovery count:** **15–20 required; fewer fails the stage with `too_few_products`** so the admin can add notes and re-run. Or accept 10–14 with a warning (niche nodes).
19. **The `/bot` page:** **a short static public page** for the User-Agent link. Or a link to the repository README.
20. **Manual values:** **removed** (spec: no manual data entry; quotes required). Or an admin path with URL plus pasted quote, verified against a fresh fetch of that URL (needs the host on the allow-list).

## 5. Decisions recorded

### Changes at approval

**A1. Automated product approval** (replaces manual product approval, and the rule that a domain joins the allow-list when an admin approves a product; spec step 4, "Verify and auto-approve").

- **`BrandDomain`** (`brand_domains`, replaces `ManufacturerDomain`):
  - Fields: `brandKey` (normalized brand: lower case, letters and digits only), `brand` (display), `host` (unique; lower case, `www.` stripped), `status` (`VERIFIED` / `PENDING_CONFIRMATION` / `REJECTED`), `verifiedVia` (`AUTOMATIC` / `ADMIN`), `verifiedById`, `verifiedAt`, `checkResult` (JSON: which checks passed, the site name found), and the rate-limit and robots.txt cache fields D2 gave `ManufacturerDomain`.
  - A brand may have more than one verified host.
  - **The allow-list is the set of `VERIFIED` hosts.**
- **Brand verification is automatic.** When discovery returns a host for a brand with no verified domain, the run checks robots.txt, then fetches only that host's home page (the same fetcher, rate limit and denylist). The host is **verified** when all of these hold:
  - it is https;
  - it is not denylisted;
  - its registrable-domain label (the label left of the public suffix, from `tldts`, hyphens removed) contains the normalized brand name;
  - the home page's schema.org `Organization` or `Brand` name, or its `og:site_name`, matches the brand. "Matches" means equal after normalization, ignoring trailing generic words such as "baby", "usa", "official", "inc".
- **Failures.** A host that fails any check goes to the admin **Confirm brand domain** list with the failed check: one click per brand, ever. A denylisted host is never offered there; it is refused outright.
  - Fetching a home page is the one fetch allowed before a host is verified. It is limited to `https://<host>/` and that host's robots.txt.
  - Confirming a brand domain queues its waiting products.
- **A product is auto-approved** (`catalogStatus = APPROVED`, `approvedVia = AUTO`) when all of these pass:
  1. its URL host is a verified host for its brand;
  2. the page fetch outcome is `OK`;
  3. the fetched page names the model: a normalized match of the model name in the `<title>`, an `<h1>` or a schema.org `Product` name;
  4. the extraction call classifies the product as belonging to this node with confidence `HIGH` (only `HIGH` auto-approves);
  5. it is not a duplicate of a product in another node (same normalized brand and name, or the same URL).
- **Products that fail a check do not block the run.** They become `NEEDS_ATTENTION` with `attentionCheck` and `attentionReason`, and the run continues.
  - Values are still extracted when the page was fetched, so the admin can approve with one click (`approvedVia = ADMIN`) or ignore them.
  - Needs-attention products are never listed.
- **Run flow.** The run goes PLACE → LEVERS → DISCOVER → **VERIFY** (brand domains) → EXTRACT (with the product checks) → `READY_FOR_REVIEW`, with no pause.
  - In the review screen the admin can reject or unlist any product before publish; "Products" is a review of exceptions, not an approval step.
  - The product approve endpoints stay, for needs-attention products.
- **Tests** (all mutation-checked):
  - a lookalike domain is rejected (brand token present, site name mismatch);
  - a denylisted host is rejected;
  - a model-name mismatch goes to needs attention;
  - `LOW` and `MEDIUM` node classification go to needs attention;
  - a duplicate goes to needs attention.

**A2. PDF manuals (Q4 changed).**
- **Which PDFs.** Text-based PDF manuals are included when either:
  - they are hosted on a verified host of the product's brand; or
  - they are linked from the approved product's page. These are fetched under the same rules: denylist, robots.txt, rate limit and no blocks bypassed. Their host does not need to be a verified brand host. This follows your instruction; the spec says "hosted there", so this is a deliberate widening, recorded here.
- **How many.** At most 2 PDFs per product, chosen from links whose text or URL mentions a manual, instructions or specifications.
- **Text.** It is extracted with **`pdfjs-dist`** 6.5.438 (new dependency) in a separate Node process (`backend/pdf-worker/extract-text.mjs`). The parser runs on untrusted files with a memory cap and a 20 s timeout, and the backend (CommonJS) need not load an ES module.
- **Scanned PDFs.** A PDF with under 25 characters of text per page on average is treated as scanned and skipped (`SCANNED_PDF`).
- **Same rules as pages.** The extraction call names the document each quote comes from. The verbatim check runs against that document's text, and `sourceUrl` is that document's URL. Unit rules are unchanged.
- **Cost.** PDF text is capped at about 20k tokens per product, which raises the estimate to about **$4.30 per node** (extraction about $0.19 per product).

**A3. Discovery count (Q18 changed).** 15–20 products is the target. A result of 10–14 is accepted with a warning shown on the run; the stage fails (`too_few_products`) only below 10.

**A4. Manual values (Q20 changed).** An admin can enter a value with a source URL and a pasted quote.
- **URL on a verified host of the product's brand, and fetchable:** the quote must appear verbatim in a fresh fetch (same normalization as D7); otherwise the save is a 400 and nothing is stored.
- **The fetch is blocked** (robots.txt disallows, 401/403/429, a challenge page): the value is stored as **admin-attested**, with the fetch outcome.
- **The URL is not on a verified host of the product's brand:** refused, because values come only from verified brand domains.
- **Status.** Manual values are stored `ACCEPTED`, accepted one by one by the admin who entered them, with `origin = MANUAL`.
- **Coverage and bulk accept.** Both kinds count toward coverage. They are never bulk-accepted: the API excludes them and the database trigger refuses `acceptMode = BULK` on a manual value.
- **Public pages** label an admin-attested value "Admin-attested".

**A5. All other open questions:** the recommended defaults in section 4.

### Dependencies (D14, updated)

| Package | Version | Why |
|---|---|---|
| `robots-parser` | 3.0.1 | robots.txt matching |
| `htmlparser2` | 10.1.0 | HTML to text, and title, h1, schema.org and og:site_name for the checks |
| `tldts` | 7.4.19 | Public Suffix List lookups for the registrable-domain check (A1) |
| `pdfjs-dist` | 6.5.438 | PDF text (A2). It pulls in the optional native `@napi-rs/canvas`, which is only used for rendering; we never render. |

All are pinned exactly, at versions at least two weeks old.

### Changes made during implementation

- **A public copy of values** (`published_lever_values`) replaces the `published` flag on `product_lever_values`. Publish copies the accepted values of the five levers there; public pages and filters read only the copy. An edit, a re-extraction or a review decision after a publish therefore never reaches the public before the next publish (with a flag, an edit to a published row would have shown at once).
- **`listed` is the publish snapshot.** A product rejected, or moved to needs attention by a re-run, after a publish stays listed until the next publish (which lists approved products only). The database requires only that a listed product is placed.
- **A known value must have a value** (CHECK), so an empty row can never count toward coverage.
- **Rate limiting and robots.txt per host** live in `fetch_hosts`, separate from the allow-list (`brand_domains`), because PDF hosts linked from a product page and hosts waiting for confirmation need them too.
- **PDFs "linked from an approved product page"** means: linked from the product's page once that page has passed the brand-domain and fetch checks (its auto-approval also depends on the extraction call that reads the PDFs). At most two, chosen by link text or URL mentioning a manual, instructions or specifications.
- **Evidence normalization** also maps typographic quotes and dashes to their ASCII forms on both sides (pages and the model differ on these); case and all other punctuation still count.
- **The stated unit must appear in the quote** (a short spelling such as "in" only right after a number), and the canonical units are `lb`, `in`, `cu ft`, `years` and `count`.
- **Phase A values** keep their typed value as `PHASE_A` proposals (rather than becoming unknown), so an admin can see what was entered; a CHECK forbids accepting them.
- **The scanned-PDF threshold** is 25 characters of text per page on average (100 rejected short but real manuals).
- **`htmlparser2` 10.1.0** instead of 12.0.0: 12.x is ESM-only, which the CommonJS backend's Jest setup cannot load; 10.1.0 ships a CommonJS build.
- **Search** lists public nodes first, then names that start with the query; plural and singular forms both match.
- **The review screen** puts the three steps and the publish gate above the grid (not in a side rail), so five lever columns, the products and the evidence panel fit at 1440 px without sideways scrolling. Value progress counts the chosen levers only.

#### From the code review (before the PR)

- **Products added by users are not in the catalog.** `POST /api/products` still creates an approved product for its own page and reviews (`approvedVia` null), but the catalog (gate, listing, admin counts) is `APPROVED` with `approvedVia` set (`catalog/products.ts`, `IN_CATALOG`; CHECK `products_approved_via`). The review screen shows them as proposed ("added by a user"); an admin approves or rejects them like any exception.
- **Public product pages follow the catalog.** `GET /api/products/:id` and `POST /api/reviews` see a product only if it is listed, or user-added and not rejected; a discovered product is public only once a publish lists it, and dry-run products are hidden outside development and test.
- **Review decisions are conditional.** Accept, reject and unknown take `seen` (the value's `updatedAt` as the screen showed it); a value that changed since (a re-extraction, another admin) is a 409 and the screen reloads.
- **A corrected value is an admin decision too.** A re-extraction skips values that are accepted, manual, or edited (corrected but not yet accepted), and writes values under the same node lock as the review path.
- **robots.txt** is read from the request's own origin (a www-only site), its redirects must stay on the host, and 401/403/429 or a challenge on robots.txt is a block that pauses the host like any other.
- **Hosts the fetcher refuses outright:** a non-default port, IP literals, `localhost`, single-label and internal names (`.local`, `.internal`, …). Brand verification fetches the home page from the product URL's own origin.
- **The unit must follow the number it measures** ("9.1 kg; up to 22 lb" does not support 22 kg). For dimensions, at least one of the three numbers must carry the unit.
- **Cost reservation for discovery** covers every request it may make (the first plus `MAX_PAUSE_RESUMES` resumes). A failed call with no usage reported keeps a null cost, so its reservation keeps counting against the caps (the request may have been billed).
- **Resume** puts back only extraction items whose heartbeat is stale, so a live worker's item is never processed twice.
- **Retailer URLs** proposed by discovery are dropped (counted in the stage output as `droppedRetailers`); an admin cannot approve a product whose URL is a retailer's.
- **A bot challenge on a manual value's page** is a block: the host is paused and the value is admin-attested with outcome `BLOCKED`.
- **Moving a product to another node** deletes its old node's public copy; **waiting items of a closed run** (published or cancelled) are failed when their brand is confirmed, so they never block the node's next publish.
- **Known risk: lookalike domains an admin confirms.** Automatic verification needs both the brand in the registrable domain and a matching site name, but "Confirm brand domain" is one click; an admin who confirms a reseller's domain puts it on the allow-list for that brand. The confirm screen shows the failed check and the site names found; there is no second reviewer.
