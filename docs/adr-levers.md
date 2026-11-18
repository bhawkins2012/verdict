# ADR: Categories, value levers and lever generation (Phase A core)

**Status:** accepted with changes (Phase A, branch `phase-a-levers`). The answers to the open questions and the changes made during implementation are in section 6; where section 6 differs from sections 2 to 5, section 6 wins. Product rules: `docs/product-spec.md`, sections "Reviews half: search, value levers, product pages" and "Lever generation and review synthesis".

## 1. Context

What exists today and matters here:

| Area | Today | Consequence |
|---|---|---|
| Categories | `Product.category` is a free string (`"kitchen"`, `"furniture"`, `"home"`, `"outdoor"` in the seed). `GET /api/products/categories/list` groups by it. The ML service filters by it (`ml/main.py`, `category` request field). | A `Category` table is added beside the string, not instead of it (D2), so the ML service and existing filters keep working. |
| Product attributes | `Product.attributes` is free JSON with no source or provenance. | Lever values get their own table with a required source (D5). `attributes` is left alone. |
| Roles | No roles. `authenticate` puts `req.userId` on the request; the JWT carries only `sub`. | Admin role on `User`, checked from the database on every admin request (D1). |
| Background work | BullMQ + Redis for nudges, with a reconciler because Redis can be down. Account emails run in-process after the response (`afterResponse`). | Generation runs in-process after the response (D3); no new Redis dependency. |
| Product creation | `POST /api/products` takes a category string and spreads `body.data` into the Prisma `data` block (against the conventions). | Touched to set `categoryId`; the spread is replaced with explicit fields while there. |

Spec rules this design must hold (copied from the request):

- A published category has **exactly five** levers, each with a type (measurement, category, compatibility list, boolean), units where relevant, a one-line explanation and an order 1 to 5.
- Levers are generated automatically, then a person approves. **Nothing generated is ever shown to users unapproved.**
- Every lever value carries a source (URL or "entered by admin") and who/when recorded it.
- No web scraping this sprint, of any site.

## 2. Decisions

### D1. Admin role

- `User.role` enum `UserRole { USER, ADMIN }`, default `USER`.
- **Checked from the database on every admin request** (`requireAdmin` middleware after `authenticate`: one `select role` by `req.userId`). The JWT does not carry the role, so revoking admin takes effect at once and an old token cannot carry a stale role.
- No API grants admin. Bootstrap: the seed creates `admin@example.com` (verified, `password123`, like the other demo users), and `npm run admin:grant -- <email>` / `admin:revoke` (backend script, normalized address lookup) for real environments.
- Unauthenticated → 401, authenticated non-admin → 403 on every `/api/admin/*` route.
- `GET /api/auth/me` adds `role` so the UI can show the Admin link. The UI check is cosmetic; the server check is the guard.

### D2. Schema

New enums: `UserRole`, `LeverType { MEASUREMENT, CATEGORY, COMPATIBILITY_LIST, BOOLEAN }`, `LeverStatus { CANDIDATE, APPROVED, RETIRED }`, `LeverOrigin { GENERATED, ADMIN }`, `RunStatus { RUNNING, SUCCEEDED, FAILED }`, `RunMode { LIVE, DRY_RUN }`, `ValueSourceType { URL, ADMIN_ENTERED }`.

**Category** (`categories`)

| Field | Notes |
|---|---|
| `id`, `createdAt`, `updatedAt` | |
| `slug` | unique, `lower(btrim(...))`, URL key (`strollers`). Matches `Product.category` values. |
| `name` | display name ("Strollers") |
| `searchTerms` | `String[]`, for search matching later (spec: search matches categories first) |
| `leversPublishedAt`, `leversPublishedById` | set when a set of five is published (D4); null = no public levers |

**ValueLever** (`value_levers`)

| Field | Notes |
|---|---|
| `id`, `categoryId`, `createdAt`, `updatedAt` | |
| `name` | ≤ 60 chars; unique per category among non-retired levers (case-insensitive, enforced in the transaction; see D4) |
| `type` | `LeverType` |
| `unit` | required for `MEASUREMENT` (`lb`, `cu ft`), null otherwise; CHECK in SQL |
| `explanation` | one line, ≤ 200 chars |
| `relatedNeeds` | `String[]` (for example `air travel`, `rough terrain`); used later by projects |
| `allowedValues` | `String[]`; required (≥ 2) for `CATEGORY` before it can be approved, empty otherwise |
| `status` | `LeverStatus`, default `CANDIDATE` |
| `position` | `Int?`, 1–5, **non-null exactly when `status = APPROVED`** (CHECK); `@@unique([categoryId, position])` (NULLs do not collide in Postgres, so candidates and retired levers never conflict) |
| `origin` | `GENERATED` (from a run) or `ADMIN` (typed in by an admin) |
| `runId` | the `LeverCandidateRun` that produced it, null for `ADMIN` |
| `approvedById`, `approvedAt` | the approval record the spec asks for (who, when) |
| `retiredById`, `retiredAt` | |
| `editedById`, `editedAt` | last edit, so an approved lever changed after approval shows who changed it |

**LeverCandidateRun** (`lever_candidate_runs`)

| Field | Notes |
|---|---|
| `id`, `categoryId`, `createdById`, `createdAt`, `finishedAt` | |
| `mode` | `LIVE` or `DRY_RUN` |
| `status` | `RUNNING` → `SUCCEEDED` / `FAILED` |
| `model` | the model requested (`ANTHROPIC_MODEL`), and `servedModel` (response `model`, which differs if the refusal fallback ran, D3); `dry-run` in dry-run mode |
| `input` | JSON: prompt version, category name and search terms, the admin's notes, `maxTokens`, `effort` |
| `output` | JSON: the validated candidates, or null on failure |
| `error` | short reason on failure (`validation_failed`, `refusal`, `max_tokens`, `api_error:<status>`, `timeout`); never the API key or full response body |
| `inputTokens`, `outputTokens`, `cacheReadTokens` | from `response.usage` (output includes thinking tokens) |
| `costUsd` | `Decimal(10,6)`, computed from usage and a price table in code (D3); null if the model is not in the table (logged as a warning) |

**SurveyImport** (`survey_imports`) and **SurveyRanking** (`survey_rankings`)

- Import: `id`, `categoryId`, `filename`, `uploadedById`, `uploadedAt`, `rowCount`.
- Ranking row: `importId`, `leverName`, `rank` (int ≥ 1), `respondentCount` (int ≥ 0).
- The approval screen shows the **newest** import per category, matched to candidates by normalized name (lower case, collapsed whitespace). Unmatched survey rows are listed separately ("in the survey, not among candidates") so nothing silently disappears.

**ProductLeverValue** (`product_lever_values`)

| Field | Notes |
|---|---|
| `id`, `productId`, `leverId` | `@@unique([productId, leverId])`: one current value per product and lever |
| `isUnknown` | the spec's "explicit unknown"; when true all value columns are null |
| `valueNumber` | `Float?` for `MEASUREMENT` |
| `unit` | `MEASUREMENT` only; must equal the lever's unit (validated; no unit conversion this sprint) |
| `valueText` | `CATEGORY`: one of the lever's `allowedValues` |
| `valueBool` | `BOOLEAN` |
| `valueList` | `String[]`, `COMPATIBILITY_LIST` (for example compatible car seat models) |
| `detail` | optional free text shown next to the value (for example "22 × 18 × 9 in, one-hand fold") |
| `sourceType` | `URL` or `ADMIN_ENTERED`, **required** |
| `sourceUrl` | required when `URL` (http/https only), null otherwise; CHECK in SQL |
| `sourceLabel` | optional ("Manufacturer spec page", "Owner's manual p. 12") |
| `isSample` | true for seed data; the UI marks it "Sample data" |
| `recordedById`, `recordedAt` | required |

Typed value columns (not one JSON value) so the category page can filter in SQL (D6). A value's shape is validated against its lever's type by one zod-based function used by the form, the CSV import and the seed.

**Changes to existing tables**

- `User.role` (above).
- `Product.categoryId` (nullable FK to `Category`, indexed). `Product.category` (string) **stays** and is kept equal to the category's slug on every write, because the ML service and the existing filters read it. Removing the string is a later change.

**Database invariants that Prisma cannot express** (raw SQL in the migration, like the email `CHECK`s; `migrate diff` ignores `CHECK` constraints and triggers):

1. `value_levers`: `(status = 'APPROVED') = (position IS NOT NULL)`; `position BETWEEN 1 AND 5`; `type = 'MEASUREMENT'` ⇔ `unit IS NOT NULL`.
2. `product_lever_values`: `(sourceType = 'URL') = (sourceUrl IS NOT NULL)`.
3. **Exactly five or zero approved levers per category**: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `value_levers` that, at commit, fails if any touched category has an approved count other than 0 or 5. The publish transaction (D4) can then retire the old set and approve the new one in any order. This makes "exactly five" a database rule, not only a route check.

**Migration plan.** One migration, `20261118000000_value_levers`, applied with `prisma migrate deploy` only (authored with `migrate dev` in an interactive terminal, then the raw SQL appended). It:

1. creates the enums and tables above and adds `users.role` (default `USER`) and `products.categoryId`;
2. backfills: `INSERT INTO categories (id, slug, name, ...) SELECT ... FROM (SELECT DISTINCT lower(btrim(category)) ...)`, with `name` = the slug capitalized and ids from `gen_random_uuid()::text` (cuid is generated in the app, not SQL; ids are opaque strings, so a uuid is fine), then `UPDATE products SET "categoryId" = c.id ... WHERE lower(btrim(p.category)) = c.slug`;
3. adds the CHECKs and the constraint trigger.

Backfilled categories (kitchen, furniture, home, outdoor) have no levers and are unpublished. The seed adds `strollers` (D8). `prismaClientGuard.ts` gets the new models and fields the lever code uses, so a stale client fails at startup as today.

### D3. Generation job

**Trigger.** `POST /api/admin/categories/:id/runs { notes? }` (admin only). The handler checks the daily limit, inserts a `RUNNING` run and answers **202 `{ runId }`**; the work continues in-process after the response (the account-email `afterResponse` pattern). The admin screen polls `GET /api/admin/runs/:id` every 2 s. No Redis or BullMQ: runs are rare, an admin is waiting for them, and a lost run is simply re-run.

**Crash safety.** A run still `RUNNING` 10 minutes after `createdAt` is marked `FAILED` (`error: "timeout"`) at startup and whenever runs are listed. Candidates are written in the same transaction that marks the run `SUCCEEDED`, so a crash never leaves half a candidate set.

**Model call.** The official TypeScript SDK, `@anthropic-ai/sdk` (new dependency, D9):

- `client.messages.parse(...)` with `output_config.format = zodOutputFormat(CandidateSetSchema)` (structured outputs: the API constrains the response to the JSON schema).
- **Our own zod validation runs again on the parsed result** and is the only gate: 10–12 candidates; `name` 2–60 chars, unique case-insensitively; `type` one of the four; `unit` present for `MEASUREMENT` and absent otherwise; `explanation` 10–200 chars, one line; `relatedNeeds` 1–6 short strings. Anything else → run `FAILED` with `validation_failed`, **no candidates stored**, tokens and cost still recorded (the call was billed).
- Also `FAILED`, nothing stored: `stop_reason` `refusal` (after the fallback, below) or `max_tokens` (truncated output), and SDK errors (typed classes, not string matching; `error: api_error:<status>`). The SDK's own retries (2, on 429/5xx/connection) stay on.
- Settings: `model = ANTHROPIC_MODEL`, `max_tokens = LEVER_GEN_MAX_TOKENS`, adaptive thinking (always on for the default model), `output_config.effort: "high"` (quality matters more than cost at this volume; see the estimate below). Non-streaming: the output is short.
- Refusal fallback: the request sends the server-side fallback beta (`server-side-fallback-2026-07-01`, `fallbacks: "default"`), so a safety-classifier decline is retried on a fallback model in the same call. Unlikely for this task; `servedModel` records which model answered. Can be dropped (Q7).
- Prompt: a fixed system prompt (what a value lever is, the four types, "attributes that decide whether a product fits someone, measurable or checkable from a spec sheet, not brand names, not quality judgements", return 10–12) and a user message with the category name, search terms and the admin's notes (≤ 1,000 chars). The prompt carries a version string stored in `run.input`.
- Untrusted output: the model's text is data. It is rendered as plain text (React escapes it), stored only as `CANDIDATE` rows, and never reaches a public route (D4, D6).

**Model.** `ANTHROPIC_MODEL` default **`claude-opus-5-5`**, the current default recommended on the Claude docs models overview (checked 2026-11-18: "If you're unsure which model to use, start with Claude Opus 5.5"; $4 / $20 per million input/output tokens). The default lives in one place (`backend/src/levers/config.ts`) and the env var overrides it, so moving to a newer model is a config change.

**Cost and safety controls.**

| Control | How |
|---|---|
| Admin-only trigger | `requireAdmin` on every `/api/admin/*` route (D1) |
| Per-run token cap | `max_tokens = LEVER_GEN_MAX_TOKENS` (default 16000; covers thinking + output). Input is bounded by the fixed prompt and the 1,000-char notes limit. |
| Per-day run limit | `LEVER_GEN_DAILY_LIMIT` (default 10) **live** runs in any rolling 24 h, across all admins. Counted and inserted inside one transaction under a Postgres advisory lock, so two concurrent clicks cannot both pass at the limit. Over the limit → 429 with the time the next run is allowed. Dry runs are not counted. |
| Logged cost per run | tokens + `costUsd` stored on the run and logged (`logger.info('Lever generation finished', { runId, model, inputTokens, outputTokens, costUsd })`). Price table in `levers/pricing.ts` for the current models; unknown model → `costUsd` null + warning. |
| Dry run | `LEVER_GEN_MODE=dry_run` (default) returns fixture candidates without calling the API: a stroller fixture for slug `strollers`, otherwise a generic fixture built from the category name. Fixtures pass through the same zod schema and the same storage path, with `mode: DRY_RUN`, `model: "dry-run"`, cost 0. |
| Live mode needs a key | `LEVER_GEN_MODE=live` without `ANTHROPIC_API_KEY` → the API refuses to start (same as `resend` without its settings). |
| CI and tests | `LEVER_GEN_MODE` defaults to `dry_run`, and `tests/setupEnv.ts` sets it explicitly; tests of live mode inject a mocked client (D10). No test can reach the real API. |

**Cost estimate.** About 1.5k input tokens and 3–10k output tokens (thinking included) per run: roughly $0.07–0.21 per run at Opus 5.5 prices, so the default daily limit caps spend near $2/day.

**Env vars** (backend, documented in `.env.example` with empty/placeholder values; `.env` is never committed): `ANTHROPIC_API_KEY` (live only), `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `LEVER_GEN_MODE` (`dry_run` | `live`, default `dry_run`), `LEVER_GEN_MAX_TOKENS` (16000), `LEVER_GEN_DAILY_LIMIT` (10).

### D4. Review, approval and publishing

Admin actions (all admin-only, all recorded with who/when):

- **Edit** a candidate or an approved lever: name, type, unit, explanation, related needs, allowed values. Type and unit cannot change on a lever that already has product values (409; retire it and add a new one instead).
- **Add** a lever by hand (`origin: ADMIN`, starts as `CANDIDATE`).
- **Retire** a candidate (discard). An approved lever cannot be retired on its own, because the category would drop to four; it leaves the set by publishing a set without it.
- **Approve and publish** in one step: `POST /api/admin/categories/:id/publish { leverIds: [5 ids, in order] }`. One transaction, with the category row locked (`SELECT … FOR UPDATE`): checks exactly five distinct, non-retired levers of this category, `CATEGORY` levers have allowed values; sets them `APPROVED` with positions 1–5 and `approvedById/At` (kept if already approved); sets previously approved levers that are not in the new set to `RETIRED`; sets `leversPublishedAt/ById`. The deferred trigger (D2) re-checks the count of five at commit.

So `APPROVED` means published: there is no state in which a lever is approved but hidden, or visible but unapproved (Q1 is the alternative). Product values of a retired lever stay in the database but are not shown.

**One public read path.** Public routes get levers only through `publicLevers(categoryId)`, which selects `status = 'APPROVED'` and `category.leversPublishedAt IS NOT NULL`. Tests assert that candidates and retired levers never appear in any public response (D10).

### D5. Lever values

- **Admin form** on the product's admin view: one row per approved lever, an input that matches the type (number + fixed unit, select of allowed values, list, yes/no), "Unknown", optional detail, and **source: URL or "Entered by admin" (required, no default)**, optional source label. `PUT /api/admin/products/:productId/levers/:leverId` upserts the current value and sets `recordedById/At`.
- **CSV import** per category: `POST /api/admin/categories/:id/lever-values/import`, CSV text as the body (`text/csv`, ≤ 1 MB; the browser reads the file and posts its text, so no multipart dependency). Columns: `product_id, lever, value, unit, unknown, detail, source_url, source_label`; `lever` is the lever name; an empty `source_url` means "entered by admin". Values in lists are separated by `|`. **All or nothing:** every row is validated first; any error returns 400 with the row numbers and reasons, and nothing is written. `?dryRun=true` validates only, so the admin can check a file before importing.
- Values can only be set for approved levers of the product's own category.
- Every value is validated by the same function (D2), whatever the path. A URL source must be http(s); no URL is ever fetched.

### D6. Public pages and API

- `GET /api/categories`: categories with product counts and whether levers are published.
- `GET /api/categories/:slug`: the category, its five levers (from `publicLevers`, in order, with explanation, type, unit, allowed values) and products, with lever filters as query parameters: `MEASUREMENT` `min`/`max`, `CATEGORY` one or more allowed values, `COMPATIBILITY_LIST` contains a value, `BOOLEAN` yes/no. A product whose value is unknown or missing does not match an active filter. Filter parameters are validated with zod; an unknown lever id or a bad value is 400 (not a 500).
- Sort: name for now, with a note that Best Fit and Top Rated arrive in Phase C. No ranking change in this sprint.
- `GET /api/products/:id` adds `levers: [{ lever, value, detail, source: { type, url, label }, isSample, recordedAt }]` for the approved levers of its category (unknown and missing values shown as such), plus the category typical value for measurements (median of the category's known values), as the spec's product page asks.
- Frontend: a new category page `/categories/:slug` (lever filters at the top, each with its one-line explanation; filtering updates the list without a page reload via React Query), the product page gets a "Key specs" section with each value and its source link (or "Entered by admin") and a "Sample data" mark where `isSample`, the Discover page's category chips link to the category page, and a category with no published levers shows its products with "Levers for this category are being prepared".
- Admin UI under `/admin` (link shown only to admins): category list and create; category view with runs (status, model, tokens, cost), candidates side by side with the survey ranking, inline edit, select-five-and-order then Publish, retire; survey CSV upload; lever value form and CSV import.

### D7. Survey import

`POST /api/admin/categories/:id/survey` with CSV text (`lever, rank, respondents`; ≤ 1 MB; all or nothing, like D5). Stored as a `SurveyImport` with its rows. Re-uploading creates a new import; the newest one is shown. No vendor integration.

### D8. Seed

- `admin@example.com` / `password123`, `role: ADMIN`, verified.
- Category `strollers` (search terms "stroller", "pram", "pushchair", "travel system") with the five spec levers **approved and published**, `origin: ADMIN`, approved by the seed admin:

| # | Lever | Type | Unit / values | Value stored (filterable) | `detail` holds |
|---|---|---|---|---|---|
| 1 | Fold size | Measurement | cu ft | folded volume (Q2) | folded L × W × H; one-hand fold yes/no |
| 2 | Weight | Measurement | lb | weight | |
| 3 | Car seat / travel system compatibility | Compatibility list | | compatible car seat models | adapter needed yes/no |
| 4 | Wheel material | Category | Rubber, Foam-filled, Plastic | material | |
| 5 | Seat size and adjustability | Measurement | lb | seat weight limit (Q3) | recline positions, seat height |

- Four or five sample strollers with fictional names (Q4), every value `isSample: true`, `sourceType: ADMIN_ENTERED`, source label "Sample data", recorded by the seed admin, including one explicit unknown.
- Existing seed products get their backfilled categories (unpublished).

### D9. Dependencies

- **`@anthropic-ai/sdk`** (backend). Chosen over plain `fetch` because it gives typed request and response types, typed error classes, built-in retries with backoff on 429/5xx, and the structured-output helper that turns the zod schema into the request's JSON schema. With `fetch` all of that would be hand-written and untyped, against the "no `any`, validate external data" rule. Its zod helper needs a compatible zod; the backend has zod 3.25.x, which includes the `zod/v4` entry point. Checked during implementation: if the helper and our zod do not fit, the fallback is `output_config.format` with a hand-written JSON schema and the same zod validation of the result (no other dependency change).
- **`csv-parse`** (backend) for the two CSV imports, unless you prefer a small hand-written parser (Q9).
- No frontend dependencies.

### D10. Testing plan (Step 3)

Backend tests run against real Postgres (test schema); the Anthropic client is injected and mocked; no test can call the real API.

| Test | Mutation check (guard removed or weakened → test must fail) |
|---|---|
| Malformed model output is rejected: 9 and 13 candidates, missing unit on a measurement, unit on a boolean, unknown type, duplicate names, multi-line or empty explanation, non-JSON / `parsed_output` null, `stop_reason` `refusal` and `max_tokens`. Each → run `FAILED`, zero candidates stored, tokens recorded. | loosen the count bound; drop the unit refinement; skip re-validation of the parsed output |
| Dry run is the default: with `LEVER_GEN_MODE` unset the mocked client is never called and fixture candidates are stored with `mode: DRY_RUN`. Live mode without a key fails config validation. | flip the default to `live` |
| Daily run limit: at the limit → 429 and no run row; dry runs not counted; two concurrent requests at limit − 1 → exactly one succeeds. | remove the check; remove the advisory lock (concurrency test fails) |
| Admin-only: every `/api/admin/*` route → 401 without a token, 403 for a normal user, and a user demoted after login gets 403 with the same token. | remove `requireAdmin` from one router; read the role from the token instead of the database |
| Exactly five: publish with 4 or 6 ids → 400; a direct database update that leaves 4 approved fails at commit (trigger); republishing a new five retires the old ones. | remove the route check (the trigger test still holds the line, and the route test fails on status); drop the trigger |
| Source required on every value: form and CSV without source → 400; URL source with a non-http URL → 400; direct insert with `sourceType = URL` and no URL fails (CHECK). | make `source` optional in the zod schema; drop the CHECK |
| Unapproved never public: with candidates, retired levers and an unpublished category present, `GET /api/categories/:slug`, `GET /api/categories` and `GET /api/products/:id` contain only the five approved levers (checked by id and by candidate name). | remove the `status` filter from `publicLevers` |
| Plus: CSV all-or-nothing, value shape per type, filters (each type, unknown excluded, bad parameters 400), survey matching, migration backfill of `categoryId`. | |

Frontend tests (Vitest) for the category filters and the product page source rendering. Browser check (Playwright, dev servers, dry-run mode): log in as admin → create a category → run generation → see candidates beside an uploaded survey → edit one → select and order five → publish → category page shows the five filters → filter → product page shows values with sources; and a normal user gets no Admin link and a 403 from the API.

## 3. API summary (detailed in `docs/api.md` in Step 4)

Admin (auth + admin): `GET/POST /admin/categories`, `GET /admin/categories/:id`, `POST /admin/categories/:id/runs`, `GET /admin/runs/:id`, `POST /admin/categories/:id/levers`, `PATCH /admin/levers/:id`, `POST /admin/levers/:id/retire`, `POST /admin/categories/:id/publish`, `POST /admin/categories/:id/survey`, `PUT /admin/products/:productId/levers/:leverId`, `POST /admin/categories/:id/lever-values/import`.

Public: `GET /categories`, `GET /categories/:slug`, `GET /products/:id` (extended), `GET /auth/me` (adds `role`).

## 4. Out of scope (backlog in Step 4)

Spec extraction from manufacturer pages; licensed-search review synthesis ("What expert reviewers say"); car seat levers; survey vendor integration; Best Fit / Top Rated ranking; project answers pre-setting filters; lever ratings in reviews; search matching categories first; unit conversion; value history (Q11); removing `Product.category`.

## 5. Open questions (recommended default in **bold**)

1. **Approve and publish:** **one atomic step (select five, order, publish)**, so approved always means visible and the five-lever rule holds at every moment; or a separate approved-but-unpublished draft state (needs a fourth status or a draft flag).
2. **Fold size, what number to filter on:** **folded volume in cubic feet** (comparable with car trunk capacity, which US makers state in cu ft), with dimensions and one-hand fold in `detail`; or the longest folded dimension in inches.
3. **Seat size and adjustability, what number:** **seat weight limit in lb**, with recline positions and seat height in `detail`; or make it a category lever (for example "Lie-flat recline / partial / upright only").
4. **Sample products:** **fictional names, clearly marked "Sample data"**, so no real product shows made-up specs; or real models with values entered from their manufacturer pages by hand (then they are real data, not samples).
5. **Admin bootstrap:** **seed `admin@example.com` plus `npm run admin:grant -- <email>` / `admin:revoke`**, no API for roles.
6. **Daily limit:** **10 live runs per rolling 24 h, all admins together, dry runs not counted.** Alternative: per admin, or a daily dollar cap on top.
7. **Server-side refusal fallback:** **on** (`fallbacks: "default"`, served model recorded). It uses a beta header; say if you would rather not depend on a beta.
8. **Effort:** **`high`** (about $0.07–0.21 per run); `medium` (the model's default) is cheaper and may be enough.
9. **CSV parsing:** **`csv-parse`** (well tested, handles quoting); or a hand-written parser to avoid the dependency.
10. **Unknown category on `POST /api/products`:** **create an unpublished `Category` row** (keeps "Add product" working, and the admin sees it in the list); or reject with 400 and require an existing category.
11. **Lever value history:** **current value only this sprint** (who/when on the current value); keep superseded values in a later change if audits need them.
12. **Generation execution:** **in-process after the response, with a 10-minute stale-run timeout**; or a BullMQ job (needs Redis and the reconciler pattern for a rare admin action).
13. **Backfilled categories:** **kitchen, furniture, home and outdoor become unpublished `Category` rows** and show "Levers for this category are being prepared"; or hide categories without levers from the public list.

## 6. Decisions recorded

### Answers to the open questions (approval of this ADR)

| Q | Decision |
|---|---|
| 1 | **As proposed:** approve and publish are one atomic step. |
| 2 | **Changed:** fold size records folded length, width and height (inches) and one-hand fold (yes/no). The filter uses the folded volume (cu ft) computed from the dimensions, never entered by hand. Implemented as `ValueLever.inputFormat = DIMENSIONS` on a measurement lever in cu ft (below). |
| 3 | As proposed: seat weight limit (lb), recline and seat height in `detail`. |
| 4 | As proposed: fictional sample products, every value marked "Sample data". |
| 5 | **Changed:** the seeded `admin@example.com` is created only when `NODE_ENV` is `development` or `test`; anywhere else `npm run admin:grant -- <email>` is the only path. |
| 6 | As proposed: 10 live runs per rolling 24 h, all admins together, dry runs not counted. |
| 7 | **Changed:** no refusal fallback; a refusal fails the run (`error: refusal`). No beta header is sent. |
| 8 | As proposed: effort `high`. |
| 9 | As proposed: `csv-parse`. |
| 10 | **Changed:** `POST /api/products` rejects an unknown category with a 400 listing the valid ones; only admins create categories. |
| 11 | As proposed: current value only. |
| 12 | As proposed: in-process after the response, 10-minute stale-run timeout. |
| 13 | **Changed:** categories without published levers are hidden from browse; a search that matches one shows "being prepared". `GET /api/categories/:slug` is 404 for them. |
| Extra | A `car-seats` category is seeded, unpublished, with no levers, ready for a live run. Backlog #19 removes `Product.category` once the ML service reads `categoryId`. |

### Changes made during implementation

- **`LeverInputFormat` (`SINGLE` / `DIMENSIONS`) on `ValueLever`** (for Q2). The four lever types are unchanged; a `DIMENSIONS` lever is a measurement whose unit is `cu ft` (CHECK in SQL). `ProductLeverValue` gains `dimLengthIn`, `dimWidthIn`, `dimHeightIn`; `valueNumber` holds the computed volume (rounded to 0.01 cu ft) and `valueBool` the one-hand fold. Sending a volume for a dimensions lever is a 400. An admin can set the input format when editing a measurement lever. The category filter for such a lever takes `min`/`max` (volume) and `is=yes|no` (one-hand fold).
- **Structured output without the SDK's zod helper.** `zodOutputFormat` needs `zod/v4` schemas and failed to compile under ts-jest ("type instantiation is excessively deep"). The request sends `output_config.format = { type: "json_schema", schema }` with a hand-written structural schema (`CANDIDATE_SET_JSON_SCHEMA` in `levers/client.ts`), and the client parses the first text block as JSON. This is the fallback D9 named; validation is unchanged (the strict zod schema decides).
- **SDK version:** `@anthropic-ai/sdk` pinned to `1.5.0` (released 2026-11-04; 1.10.0 was a day old). SDK 1.x sends the key as `Authorization: Bearer` and pins `anthropic-version: 2026-10-21`; the request sends no sampling parameters, which that version rejects.
- **`recordedById` and `approvedById` are nullable with `ON DELETE SET NULL`**, so deleting a user never deletes values or levers. Every API path sets them; the seed leaves them null outside development and test (no admin exists there). The approval time is required on every approved lever (CHECK).
- **The real client refuses to start under `NODE_ENV=test`** unless a fake is injected, in addition to the dry-run default, so no test can reach the API. The real client class is tested with a stub `fetch` (request body, headers, response parsing).
- **Category search** matches a query inside a category term ("stroll"), or a category term as whole words inside the query ("strollers for twins"), with hyphens treated as spaces.
- **`GET /api/products/categories/list`** now lists only categories with published levers (browse rule, Q13); `GET /api/categories` is the replacement.
- **`AppError` takes optional `details`**, merged into the JSON body next to `error` (per-row CSV errors, `retryAt`, `validCategories`).
