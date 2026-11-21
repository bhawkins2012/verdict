# Verdict

Longitudinal product-review platform. Users review a product at stages (initial, 1 week, 2 weeks, 1 month, … 2 years); the app computes **drift** (how opinion changed) and recommends products using stage-weighted collaborative filtering. Design rationale lives in `docs/architecture.md`; CI in `docs/ci.md`.

## Product

The product spec is `docs/product-spec.md`. Read the relevant section before any feature work. Never edit it yourself; report conflicts instead. When the owner attaches a new version, commit it unchanged as `docs/product-spec.md` in its own commit.

## Architecture

```
frontend/  React 18 + Vite + TS + Tailwind, Zustand (auth), React Query   :5173
backend/   Express 4 + Prisma + zod + Winston, BullMQ nudge worker       :3001
ml/        FastAPI + scikit-learn recommender, TextBlob NLP, drift util   :8000
Postgres 16 + pgvector (system of record)      Redis 7 (BullMQ queue only)
```

- The browser only talks to the frontend origin. Vite proxies `/api` to the backend (`frontend/vite.config.ts`).
- The backend calls the ML service over HTTP (`backend/src/services/mlClient.ts`). Every ML response is validated with zod; if `/recommend` fails the route logs a warning and serves a popularity fallback.
- The ML service reads review data straight from Postgres (it loads `backend/.env` for `DATABASE_URL`). With no `DATABASE_URL` it uses a seeded in-memory demo matrix, which is what the tests use.
- Data model (`backend/prisma/schema.prisma`): `User` → `ReviewThread` (one per user+product) → `Review` (one per stage; **unique on `(threadId, stage)`**). `ReviewThread.driftScore = latest − initial score` by stage order; `Product.driftScoreAvg` averages its threads. `Nudge` rows schedule the next stage prompt. The catalog: `TaxonomyNode` (navigation or decision) → `NodeLever` (a shared `LeverDefinition`'s place on a decision node; five published) and `Product` (one decision node) → `ProductLeverValue` (with evidence) → `PublishedLeverValue` (the public copy); `GenerationRun` fills them. See "Catalog and the generation run".
- Auth: short-lived JWT access token + rotating refresh token stored in `refresh_tokens`. Every token carries a unique `jti`. The frontend persists `{ state, version }` under `localStorage["verdict-auth"]` (Zustand `persist`).
- `backend/src/app.ts` builds the Express app (no listener); `src/index.ts` listens and starts the worker. Tests import `app`.

## Commands

Run from the repo root unless noted. Postgres/Redis: `docker compose up -d`.

| Task | Command |
|---|---|
| First-time setup | `bash scripts/setup.sh` (the devcontainer does the equivalent automatically, see Environment) |
| Check the environment | `bash scripts/doctor.sh` (Docker, ports 5432/6379, env files, dependencies, migrations, seed) |
| Dev (all three services) | `npm run dev` (needs `uvicorn` on `PATH`; use the `ml/.venv` or install requirements globally) |
| Build | `npm run build` |
| Typecheck | `npm run typecheck` (backend + frontend; ML has none) |
| Lint | `npm run lint` (backend + frontend; ML has none) |
| Test | `npm test` · per package: `npm run test:backend` / `test:frontend` / `test:ml` |
| Generate the Prisma client | `cd backend && npx prisma generate` (also runs automatically: backend `predev`/`prebuild`/`pretest`, devcontainer install and start) |
| Apply migrations | `npm run db:deploy` (= `prisma migrate deploy`) |
| Create a migration | `cd backend && npx prisma migrate dev --name <name>` in an **interactive** terminal, then commit `prisma/migrations/` |
| Seed | `npm run db:seed` (empty database) · `npm run db:seed:catalog` adds the dev/test admin, nodes for other product categories and the stroller reference levers to an already-seeded one (idempotent; `db:seed:levers` is an alias for one release). The launch taxonomy comes from a migration |
| Grant or revoke admin | `cd backend && npm run admin:grant -- <email>` / `npm run admin:revoke -- <email>` |
| Probe one generation stage live | `cd backend && npm run generation:probe -- <place\|levers\|discover\|extract\|explain> <node-slug> [--shape-only]` (see "Catalog and the generation run") |
| Prisma Studio | `npm run db:studio` |

**After pulling** (or switching branches), in this order:
1. `git pull`
2. `bash .devcontainer/install-deps.sh` (or `npm install` in the root, `frontend/` and `backend/` if `package-lock.json` changed)
3. `(cd backend && npx prisma generate)`: `migrate deploy` does **not** update the generated client; a stale one makes the API refuse to start ("Prisma client is out of date") or, before that guard existed, fail inside background tasks ("Unknown argument `claimedAt`")
4. `npm run db:deploy` (from the root)
5. Restart the dev servers (`npm run dev`; `ts-node-dev` does not reload on a regenerated client)
`bash scripts/doctor.sh` checks each of these, including whether the generated client matches `schema.prisma`.

**Prisma commands run inside `backend/`** (`cd backend && npx prisma …`) or through the root `db:*` scripts. Prisma is only installed there; a bare `npx prisma` from the repo root can offer to download a different major version.

Demo login after seeding: `alice@example.com` / `password123` (also `bob@…`, `carol@…`). Admin (seeded only when `NODE_ENV` is `development` or `test`): `admin@example.com` / `password123`. API docs: `http://localhost:3001/api/docs` (the category and admin routes are in `docs/api.md`).

## Environment

- **One env template, localhost only.** `backend/.env.example` is a working dev default (credentials match `docker-compose.yml`); `cp backend/.env.example backend/.env`. No hostname patching or `sed`. `.env` files are gitignored; never commit one.
- Devcontainer/Codespaces uses Docker-in-Docker and the same `localhost` URLs. Lifecycle split (`.devcontainer/devcontainer.json`):
  - `onCreateCommand` runs `install-deps.sh`: dependency installs only.
  - `postStartCommand` runs `start.sh`: `docker compose up -d --wait`, then a **real Postgres readiness probe** (`scripts/wait-for-postgres.js`: connect + auth + `SELECT 1` with `backend/.env`'s `DATABASE_URL`, backoff up to 90s), then `migrate deploy` and the seed, each with 3 bounded attempts (5s, 15s backoff). The seed only ever runs against an empty database; a seed that fails after writing data is reported as a partial seed, not retried or skipped.
  - `start.sh` writes its outcome to `.devcontainer/last-start.log` (gitignored). A hook it adds to `~/.bashrc` and `postAttachCommand` print it in every new terminal, so a failed start cannot go unnoticed.
  - **Both scripts always exit 0**, printing a clear summary of what failed, so a flaky pull/install can never put the codespace into recovery mode. If the summary reports problems, run `bash scripts/doctor.sh`, fix the cause, and re-run `bash .devcontainer/start.sh`.
  - The base image is pinned to `javascript-node:22-bookworm` and the docker-in-docker feature uses `"moby": false`. The floating `22` tag moved to Debian trixie, where the feature's default Moby install aborts and the container fails to build.
- **`TRUST_PROXY`** (backend, default `1`) is how many reverse-proxy hops Express trusts for `X-Forwarded-For`; it decides `req.ip` and therefore the per-client rate-limit bucket. Set it to the real number of hops in front of the API (the Codespaces proxy and a typical single load balancer are 1; direct connections are 0). Too low puts every user in one bucket and makes `express-rate-limit` log `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`; too high lets clients spoof their IP. **Never `true`**: `parseTrustProxy` (`backend/src/lib/trustProxy.ts`) refuses it and match-everything subnets at startup. `RATE_LIMIT_MAX` (default 200 per 15 min) exists mainly so tests can use a small limit. `/api/admin` is outside it and has its own `ADMIN_RATE_LIMIT_MAX` (default 3000 per 15 min): reviewing one node by keyboard is a few hundred requests.
- The API checks at startup that the generated Prisma client has every model, field and enum value the nudge and verification code uses (`src/lib/prismaClientGuard.ts`) and exits with "Prisma client is out of date: run npx prisma generate" if not. Adding a field to that code? Add it to `REQUIRED_MODELS` there.
- Always use `prisma migrate deploy` in scripts and CI. `migrate dev` is interactive and only for authoring migrations.
- A database created earlier with `prisma db push` has no migration history, so `migrate deploy` fails with `P3005`. Recreate it (`docker compose down -v && docker compose up -d`), or baseline it by hand; which migrations to mark applied depends on the schema it was pushed from, see the README.
- Backend tests use a separate Postgres schema (`?schema=test`) in the same database and apply migrations in Jest `globalSetup`. Override with `TEST_DATABASE_URL`. They need Postgres but not Redis or the ML service (both mocked).
- Wait for Postgres with `node scripts/wait-for-postgres.js [seconds]`, never with a TCP check: a Docker-published port accepts connections before Postgres is listening behind it (first boot runs a socket-only temporary server, then restarts), which made `migrate deploy` fail with `P1001` right after `compose up`. Use `node scripts/wait-for-port.js <host> <port>` only for Redis. `pg_isready` is not installed in the devcontainer.
- The compose Postgres healthcheck uses `pg_isready -h 127.0.0.1` on purpose: without `-h` it checks the unix socket, which the first-boot temporary server serves, so the container would report healthy too early.

## Nudges

Check-in reminders for the next review stage. Design: `docs/adr-nudges.md` (read it before changing anything here). Code: `backend/src/nudges/`.

- **Cadence: 2 weeks, 3 months, 1 year, 2 years** (changed in Sprint 1, ADR section 7). Defined once, in `backend/src/stages.ts` (`NUDGE_CADENCE`, next to `STAGE_ORDER` and `STAGE_LABEL`), and served by `GET /api/config`. The frontend derives the consent copy, the next-stage call to action and stage lists from that response (`frontend/src/lib/stages.ts`); never hardcode stages or the cadence elsewhere. The ML service keeps its own stage lists; `ml/tests/test_stages.py` fails if they diverge from the Prisma enum. `ONE_WEEK`, `ONE_MONTH` and `SIX_MONTHS` are still valid stages (existing reviews keep them; `POST /api/reviews` accepts them; the UI no longer links to them), just never nudged. The thread page's next-review button is the planner's target, returned as `nextCheckIn` by `GET /api/reviews/thread/:productId`.
- **Source of truth is the DB.** One nudge row per (thread, stage). Due dates are calendar offsets from `thread.purchasedAt ?? thread.startedAt` (month offsets clamp the day); if several stages are overdue only the latest is nudged; never within 7 days of the user's last review. Submitting a review completes that stage's nudge and cancels earlier ones in the same transaction. Active nudges that are not the planner's target, including stages outside the cadence, are cancelled on the next planner pass (the hourly sweep reaches every thread), and the sender refuses (cancels) an out-of-cadence nudge whose queued job fires first. A delivered nudge for an out-of-cadence stage closes the cadence stages before it (no 2-week check-in after a 1-month email). Deploy a cadence change with no old instances still running: an old planner would re-create old-cadence rows.
- **Delivery:** BullMQ wakes a worker at `sendAt` (the due date rounded to the user's send hour in their time zone). A worker sends only after an atomic claim (`PENDING` → `SENDING` under a per-user advisory lock), then re-checks review/opt-in/verified email/daily cap. The **reconciler** (startup + every 5 min) recovers stale claims, re-creates missing jobs, re-plans hourly, and **sends inline when Redis is down**, so nudges survive Redis outages.
- **Delivery is at-least-once on a crash after send.** If the process dies (or the database is briefly unavailable) after the provider accepted the email but before the row is marked `SENT`, the stale claim is recovered and the email is sent again; the provider's `Idempotency-Key` (`nudge/<id>`, same on every attempt) is the only guard against that duplicate.
- **Consent:** email is opt-in (`users.emailNudgesEnabled`, default `false`). After a user's first `INITIAL` review of each product the thread page shows an unchecked toggle whose label is the API's `consentCopy` (checking it also saves the browser time zone), until the user opts in (ever: `users.emailNudgesFirstEnabledAt` is set on the first opt-in and never cleared, so opting out later, including with the unsubscribe link, does not bring it back) or declines. "No thanks" calls `POST /api/users/me/nudge-prompt/dismiss`, which sets `users.nudgePromptDismissedAt`; the prompt never reappears. Profile → Email reminders stays the way to change the choice later, and opting in or out there does not clear the decline. Users who are opted out, or unverified while a real provider and `NUDGE_REQUIRE_VERIFIED_EMAIL=true` are in use, get the check-in in-app only. Users verify their address with the Sprint 2 flow (see "Email verification"); real sending still needs legal review first (backlog #4) and the smoke test below with a real key.
- **Unsubscribe** links are HMAC-signed with `UNSUBSCRIBE_SECRET` (dedicated, not the JWT secrets), work without login, and need a POST to take effect (the GET shows a confirm page; mail scanners prefetch links). Emails carry `List-Unsubscribe` and `List-Unsubscribe-Post`.
- **Env vars** (backend, see `.env.example`): `NUDGE_EMAIL_PROVIDER` (`console` default = dry run, or `resend`), `RESEND_API_KEY`, `NUDGE_FROM_EMAIL`, `NUDGE_POSTAL_ADDRESS` (the last three required with `resend`; startup fails otherwise), `UNSUBSCRIBE_SECRET` (required in production), `NUDGE_REQUIRE_VERIFIED_EMAIL` (default `true`), `NUDGE_DAILY_CAP` (1), `NUDGE_MAX_ATTEMPTS` (5), `NUDGES_ENABLED` (true).
- **Dry-run provider** (default): logs each email and keeps the last 50 in memory; nothing leaves the machine. See them with `GET /api/nudges/dev/outbox`.
- **Trigger a nudge manually in dev** (dev routes exist only when `NODE_ENV` is `development` or `test`; 404 otherwise, including staging or unset): log in, find a nudge id (`GET /api/nudges`, or Prisma Studio for one not yet due), then `POST /api/nudges/:id/send-now` with your bearer token. It makes the nudge due now and runs the real claim-and-send path inline (ignoring the daily cap and send hour), then returns the outcome. Your account must have email reminders on (Profile → Email reminders) to get an email rather than an in-app-only check-in.
- **Resend is unverified**: `providers/resend.ts` follows Resend's docs but has not been run against the real API. To verify: set `NUDGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY` (Codespaces secret or `backend/.env`), `NUDGE_FROM_EMAIL` (`onboarding@resend.dev` works only to your own Resend account address until a domain is verified), `NUDGE_POSTAL_ADDRESS`, `NUDGE_REQUIRE_VERIFIED_EMAIL=false` for the test user only in a dev environment, then send-now.

## Email verification

Design: `docs/adr-email-verification.md` (read it before changing anything here). Code: `backend/src/auth/`, routes in `backend/src/routes/auth.ts` and `users.ts`.

- **Addresses are normalized** (trim + lower-case) on every write and lookup (`emailField` / `normalizeEmail` in `auth/emailAddress.ts`). The database enforces it: `CHECK (email = lower(btrim(email)))` and a unique index on `lower(email)`, which Prisma cannot express (`migrate diff` ignores both). Never look a user up by a raw, un-normalized address.
- **Register never reveals whether an address is registered:** the same `202 { message: "Check your email, then sign in." }` for both; before the response both paths do the same work (username check + password hash), and the email lookup, account creation and emails happen after it (`afterResponse`; tests call `flushAccountEmails()` before checking the account), and register does **not** sign in (no tokens; the UI shows the same screen and the user signs in). A known address gets a "someone tried to sign up" email instead. A taken username is a 409 (checked first). Login runs bcrypt against a dummy hash for unknown addresses.
- **Tokens:** the link is `/verify-email#id=<selector>&t=<verifier>` (fragment: never sent to servers). Only `sha256(verifier)` is stored, compared with `timingSafeEqual`; 24 h; single use; a new token supersedes older ones; a token verifies only the address it was issued for. The page POSTs only when the user presses Confirm (mail scanners prefetch links). Every failure answers the same 400.
- **Soft gate:** everything works before verification; a banner offers Resend and Change address. Only real-provider nudge emails require a verified address (`NUDGE_REQUIRE_VERIFIED_EMAIL`). Seed users are verified.
- **The account never depends on the email path.** Register commits the user on its own, then (separately) claims the per-address slot, issues the token and sends; email change commits the new address and voids old links, then issues the token. A failure on the email path is logged (`Account email task failed` / `Account email failed`, with `task`, `userId` and `errorClass`, never the address or a token), releases the slot, and never undoes the account or changes the HTTP response; the user sees the banner and presses Resend. Keep new code in that order.
- **Account emails are transactional:** verification, "someone tried to sign up" and "email changed" ignore the email-reminder opt-in, the nudge daily cap and `NUDGE_REQUIRE_VERIFIED_EMAIL`. Sent once, after the response, best-effort (`auth/mailer.ts`); the Resend button is the retry.
- **Limits:** one verification email and one sign-up notice per address per hour (database, keyed by a hash of the address, claimed before issuing a token; released if the provider rejects the send; a slot never marked sent stops counting after 5 minutes); resend 60 s cooldown and 5 per hour per user; 5 email-change attempts per user per hour; per-IP `VERIFY_RATE_LIMIT_MAX` (default 10 per 15 min) on register, verify-email, resend and email change, keyed by `req.ip` (so `TRUST_PROXY`). Tests set it high in `tests/setupEnv.ts`.
- **Email change** (`PUT /api/users/me/email`, current password required): resets verification, supersedes links, sends a link to the new address and a masked notice to the old one; 409 if the address is in use; consent is kept.
- **Frontend URL** (links in emails, CORS): one helper, `backend/src/lib/frontendUrl.ts`, used by the email config, `app.ts` and `.devcontainer/start.sh`. In a Codespace, when `FRONTEND_URL` is unset or on localhost, it is derived as `https://$CODESPACE_NAME-<FRONTEND_PORT|5173>.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`; an explicit public `FRONTEND_URL` always wins. The API logs the resolved value at startup and warns loudly if a real provider would send localhost links. CORS allows the resolved URL, plus `http://localhost:<port>` unless `FRONTEND_URL` is an explicit public address. Vite listens on `FRONTEND_PORT` (shell, else `backend/.env`, else 5173) with `strictPort`: if that port is taken, `npm run dev`'s frontend exits instead of moving to another port (the backend and ML keep running), so free the port or set `FRONTEND_PORT`.
- **Provider config** is the nudge one (`NUDGE_EMAIL_PROVIDER`, `RESEND_API_KEY`, `NUDGE_FROM_EMAIL`, `NUDGE_POSTAL_ADDRESS`); renaming to `EMAIL_*` is in the backlog.
- **Locking:** token transactions lock the user row first (`SELECT … FOR UPDATE`) to avoid deadlocks with email change; keep that order in new code.
- **Dev:** in dry run, and only when `NODE_ENV` is development or test, the link is logged ("Verification link (dry run, not sent)") and `GET /api/auth/dev/verification-link` (same `NODE_ENV` allow-list as the nudge dev routes) returns your newest one.
- **Email smoke test (real delivery is unverified until this has been run with a real key).** `npm run email:smoke -- <address>` (in `backend/`) sends one verification-style email through the configured provider, prints the provider's answer as JSON, and exits 1 without sending if the provider is the dry run. It uses no database. Setup, once:
  1. Create a Resend account and an API key (Resend dashboard → API Keys, "Sending access" is enough).
  2. Put the settings in `backend/.env` (gitignored; never commit it) or export them in the shell: `NUDGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY=re_…`, `NUDGE_FROM_EMAIL='Verdict <onboarding@resend.dev>'` (Resend's shared test sender; until you verify a domain it can only deliver **to the email address of your Resend account**), `NUDGE_POSTAL_ADDRESS='<any text for now>'`.
  3. `cd backend && npm run email:smoke -- <your Resend account address>`. Success prints `{"ok": true, "provider": "resend", "providerMessageId": "…"}` and the message arrives with subject "[Smoke test] Confirm your email for Verdict". A failure prints `{"ok": false, "error": "Resend API <status>: …", "status": …}`; a 403 about the domain usually means the recipient is not your account address.
  4. Set `NUDGE_EMAIL_PROVIDER` back to `console` (or remove the lines) unless you mean to send real email from that environment.

## Catalog and the generation run

The taxonomy, shared lever definitions, and one generation run per decision node that proposes levers, finds products, verifies brand domains, extracts values with evidence, and ends in one review screen and an atomic publish. Product rules: `docs/product-spec.md`, "Product taxonomy" and "Lever generation and review synthesis". Design: `docs/adr-generation-run.md` (read it, including section 5, before changing anything here; it supersedes `docs/adr-levers.md` where they differ). Code: `backend/src/catalog/` (taxonomy, levers, values and units, review, publish, public reads, survey), `backend/src/generation/` (runs, model, fetcher, brands, evidence, costs, dry-run fixtures), routes `admin.ts` and `categories.ts`, UI `frontend/src/pages/admin/` and `CategoryPage.tsx`.

- **Taxonomy.** Navigation nodes have children and an explainer; decision nodes are leaves with five levers and products. One primary parent (breadcrumbs), optional "also listed in" parents. No cycles and parents are navigation nodes: checked in the API for a readable 400 and by triggers under one advisory lock. Products and levers belong to decision nodes (triggers). `safetyCritical` (Car seats) is inherited: every lever below it is safety-flagged. The launch taxonomy (Baby and Kids; Car seats, also listed in Seats; Strollers; seven decision nodes) is created by the `launch_taxonomy` migration, unpublished. URLs stay `/categories/:slug`.
- **Levers.** A `LeverDefinition` (name, type, canonical unit from `catalog/units.ts`, explanation, allowed values, safety flag) is shared by every node that uses it; a `NodeLever` is its place on one node (`CANDIDATE` / `APPROVED` = published, 0 or 5 per node by a deferred trigger / `RETIRED`). Editing a definition changes it everywhere; public pages read the snapshot taken at publish. The five Phase A stroller levers are `REFERENCE` candidates on Full-size strollers.
- **The run** (`generation/runs.ts`): `POST /api/admin/nodes/:id/runs` answers 202; stages PLACE → LEVERS → DISCOVER → VERIFY → EXTRACT run in-process, each storing its output so Resume restarts only the stage that stopped. A stage claims itself with a conditional update and heartbeats; the reconciler (startup and every minute, `index.ts`) marks it `STALLED` after 10 minutes and requeues stale extraction items. One open run per node (partial unique index). Navigation nodes get an EXPLAIN run; the admin approves the explainer.
- **Automated product approval.** DISCOVER (Claude with web search, retailers blocked, result through a strict `propose_products` tool) proposes 15–20 products (10–14 with a warning, below 10 fails). VERIFY checks each new brand host: https, not denylisted, registrable-domain label (tldts, private suffixes treated as public) contains the brand, home page's schema.org Organization/Brand or og:site_name matches; else it waits on the "Confirm brand domain" list (one click per brand; confirming requeues its products). EXTRACT auto-approves a product only when its host is a verified domain of its brand, the page fetched OK, the page names the model (title, h1 or schema.org Product), the extraction call says it belongs with confidence `HIGH`, and it is not a duplicate in another node; otherwise `NEEDS_ATTENTION` with the check and reason. Admin decisions on products (approvals, rejections) and on values (accepted, corrected and manual values; a rejected value can be re-proposed by a re-extraction) are never overridden by a re-run. Products added by users (`POST /api/products`, `approvedVia` null) are not in the catalog until an admin approves them (`catalog/products.ts`). A user who already reviews a product keeps its page and can add stages after it is rejected or unlisted.
- **Fetching** (`generation/fetch/fetcher.ts`, the only code that requests third-party pages): https on the default port, no IP literals or internal names → denylist (retailers, review sites, social) → permit (verified brand host; the home page only during verification; PDFs linked from the product page) checked on every redirect hop → host not paused → robots.txt for `VerdictBot` from the request's origin (24 h cache; 404 and other 4xx allow, 401/403/429 or a challenge is a block, 5xx/network disallows; redirects stay on the host) → one request per second per host on a database clock (`fetch_hosts`, so it holds across instances; Crawl-delay honoured) → GET with our User-Agent, no cookies, no credentials. 401/403/429 or a challenge stops and pauses the host for 24 h; never retried with other headers. No images. PDF text is extracted in a separate Node process (`pdf-worker/extract-text.mjs`, pdfjs-dist, memory cap, 20 s timeout); scanned PDFs are skipped. Fetched text is kept 24 h (`fetched_pages`, CHECK and purge); only quotes outlive it.
- **Evidence rules** (`generation/evidence.ts`, applied in code to every model answer): the quote must be verbatim in the document it names (after NFKC, whitespace and typographic-quote normalization; case and other punctuation count); the number as written must be in the quote as a whole token, followed by the stated unit (dimensions: one L × W × H group with the unit after it); every list item must be in the quote; "no" needs an explicit negation; units convert with a fixed table, and a converted value is capped at MEDIUM confidence; anything else is unknown with a reason. Never guessed.
- **Review and publish.** The review screen (`/admin/nodes/:id/review`, desktop) lists product exceptions, the PR #13 board with coverage per card, and the value grid. Accepts record who and when, and a decision or correction on a value that changed since the screen loaded is a 409; bulk accept only for non-safety levers' high-confidence extracted values (the API refuses it on safety levers and the `product_lever_values_no_bulk_safety` trigger refuses it in the database, also for manual values). A manual value needs a URL on a verified domain of the product's brand and a pasted quote that a fresh fetch finds; a blocked fetch makes it admin-attested. `POST /api/admin/nodes/:id/publish` with five ids, in one transaction: at least `GENERATION_MIN_PRODUCTS` approved products, accepted known values for ≥ 80% of them on each lever (accepted unknowns do not count), then levers approved with a snapshot, approved products `listed`, and accepted values copied to `published_lever_values`. Public reads (`catalog/public.ts`) use only those, so nothing changed after a publish is public before the next one.
- **Cost controls** (`generation/costs.ts`): every live call is reserved at its worst case under an advisory lock and refused if it could exceed `GENERATION_RUN_CAP_USD` (run) or `GENERATION_DAILY_CAP_USD` (rolling 24 h); the stage stalls with `run_cap` / `daily_cap` and resumes later. Actual tokens, searches and cost are recorded per call. About $2–5 per node with Opus 5.5.
- **Dry run is the default** (`GENERATION_MODE=dry_run`): the fixture model (`generation/fixtures/`) and fixture pages served through the real fetcher (fictional brands on `.example` hosts; Infant car seats has deliberate failures: robots.txt, 403, lookalike domain, wrong model, wrong node, kg/cm, a PDF manual, a scanned PDF, a paraphrased quote, an unstated "no"). Products are `isDryRun`; publishing them is allowed only when `NODE_ENV` is development or test. Tests pin dry run with an empty key and inject `StubModel` / a fake fetcher; the real model and the network fetcher refuse to start under `NODE_ENV=test`.
- **Env vars** (backend, see `.env.example`): `GENERATION_MODE` (`dry_run` default, or `live`; the old `LEVER_GEN_MODE` is still read, with a warning), `ANTHROPIC_API_KEY` (live only; startup fails without it), `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `GENERATION_MAX_TOKENS` (16000, at most 21000; `LEVER_GEN_MAX_TOKENS` still read), `GENERATION_RUN_CAP_USD` (10), `GENERATION_DAILY_CAP_USD` (40), `GENERATION_MIN_PRODUCTS` (10). `FRONTEND_URL` also names the `/bot` page in the fetcher's User-Agent.
- **Diagnosing a live failure.** A failed model call records `api_error:<status>: <error type>: "<API message>" (request_id …)` on the stage, the run and its `generation_calls` row, and logs `Generation model call failed` with `status`, `errorType`, `apiMessage`, `requestId` (`generation/apiError.ts`: the API's message is redacted for keys and addresses and capped at 300 characters; the SDK's own `Error.message` and request content are never stored). `npm run generation:probe -- <stage> <node-slug>` (in `backend/`) builds the exact request that stage would send for that node (`buildStageRequest` in `generation/model.ts`, the one builder the client also uses), prints its shape (keys, settings, schema, tools; prompt text only as character counts) and the local checks against the Claude API docs (`generation/requestRules.ts`), then sends it **once**, live, with no retries, and prints the response, its cost and whether the stage's zod validation accepts it, or the full error body. It refuses unless `GENERATION_MODE=live`, stores nothing, and its cost is **not** counted against the generation caps. `--shape-only` prints the shape and checks without sending (dry run too). `extract` uses the node's levers and a short stand-in document; `explain` needs a navigation node.
- **Admin role:** unchanged from Phase A: `users.role`, read from the database on every `/api/admin/*` request; `npm run admin:grant -- <email>`, or the seeded `admin@example.com` only when the seed runs with `NODE_ENV` development or test (never seed a shared database that way).
- **Run a node:** sign in as an admin → Admin → the launch order (Infant car seats first) → Run generation. Dry run takes about 20 s (one request per second per fixture host). Then: Confirm brand domain where asked → Open the review screen → Products (exceptions) → Levers (drag five) → Values (keyboard: Enter accepts and moves on) → Publish. For navigation nodes, Generate the explainer and approve it. A live run: `GENERATION_MODE=live` and `ANTHROPIC_API_KEY` in `backend/.env`, restart the API.
- **Phase A data** is migrated, not kept: categories became nodes (strollers and car-seats are navigation nodes, others root decision nodes); the stroller levers became reference candidates; sample products were deleted; remaining Phase A values are `PHASE_A` proposals that can never be accepted; `lever_candidate_runs` is read-only history.

## Conventions

- **TypeScript is strict. No `any`, `@ts-ignore` or `@ts-expect-error`**; the ESLint config enforces `no-explicit-any`. Validate external data (HTTP bodies, ML responses) with zod and derive types from the schema.
- Backend errors: `throw new AppError(status, message)` in handlers. `express-async-errors` is imported first in `app.ts` so async throws reach `errorHandler`; keep that import before any router.
- Logging: Winston takes `(message, meta)`: `logger.info('Nudge scheduled', { nudgeId })`. Never pino-style `(meta, message)`.
- Database invariants belong in the schema (unique constraints), not only in route pre-checks. Pre-checks are for friendly errors; map `P2002` to a 409.
- Never spread an external object into a Prisma `data` block; pass fields explicitly.
- The dev script keeps `--transpile-only` for speed; `npm run typecheck` is the source of truth for types.
- Frontend API calls go through `src/lib/api.ts`. Auth endpoints (`/auth/login`, `/auth/register`) return 401 for bad credentials and must not trigger the session-refresh flow.
- ML: return plain dicts/pydantic models from endpoints, not dataclass instances; SQL must quote Prisma's camelCase columns (`"userId"`).
- Commits are small and single-purpose; bug fixes ship with a regression test that fails without the fix (within the Verification budget: cosmetic UI fixes need none).

## Workflow

- Work on a branch. Never merge and never push to main.
- Gated work (schema, external services, data sourcing, cost, security, new features with product decisions): write `docs/adr-<topic>.md` from `docs/templates/adr.md` first, then stop for approval. The existing `docs/adr-*.md` notes predate the template and stay as they are.
- Ungated work (UI, bug fixes, refactors, docs): go straight to a pull request. A fix that needs a schema change or changes the security design is gated.
- Before every pull request, run the reviewer agent over the full diff and fix or list its findings.
- Backlog: `docs/backlog.md` (stable item numbers, priority table). Small items (bugs, small changes) may also be GitHub Issues, labelled `size:S`/`size:M`/`size:L` and `type:bug`/`type:feature`/`type:chore`, each with the problem and acceptance criteria.

## Verification budget

- Tests and mutation checks cover business rules, data integrity, security and safety. Cosmetic UI gets none.
- UI gets one browser pass. Admin and internal screens: desktop only. Public pages: desktop and 390 px.
- Hand-only checks (real devices, real email, payments): stop after two failed attempts and list them under Not verified. Here that includes the `email:smoke` run with a real Resend key and a live generation run.
- Do not build tooling just to verify something a person can check in two minutes.
- Infrastructure work only when a product task needs it; otherwise add it to the backlog.

## Reports

Pull request descriptions and final messages follow `.github/pull_request_template.md`. Decisions needed go first. About 40 lines at most; detail lives in commits and docs.

## Agents

Project subagents live in `.claude/agents/`. Their tool lists limit which tools they get, not which paths they touch; the path rules are in each definition, and the reviewer pass is the backstop.

- **architect**: design notes in `docs/` only (never `docs/product-spec.md`). Use before gated work, including any change to the schema, an API contract, a job or a service boundary.
- **qa**: tests and mutation checks; test files only. Use after implementing a rule or fixing a bug.
- **reviewer**: read-only review of a diff before every pull request.

## Definition of done

Typecheck, lint, tests and build pass locally and in CI (checks `Backend`, `Frontend`, `ML`) for every package touched. Reviewer findings are fixed or listed. Docs are updated: `README.md`, `docs/` and this file, whenever commands, env vars or architecture change. The pull request report is complete. For this repo that also means:

- UI changes had their browser pass (Verification budget).

- Schema changes include a committed migration; `prisma migrate diff` against the schema is empty (CI checks this).
- Rules and fixes are tested within the verification budget; a fix's test fails without the fix.
- No new `any`/suppressions, no committed `.env`, and every new dependency is listed under New dependencies in the report.

## Known gaps

- The ML service has no typecheck or linter.
- Email: real delivery (nudges and account emails) is unverified until `npm run email:smoke` has been run with a real Resend key. There is no admin view of dead-lettered (`FAILED`) nudges beyond the logs (backlog #11).
- Per-IP limits use express-rate-limit's in-memory store, so they are per process; the limits that must hold across instances are database-backed.
- `npm run dev:ml` calls bare `uvicorn`; it fails if the ML virtualenv isn't active.
- Jest runs with `forceExit` so a hung request fails the run instead of stalling; open handles haven't been audited.
- Generation run: nothing has run live yet (backlog #20): the Anthropic client is tested with a stub `fetch` (request shapes, web search, the strict tool, pause_turn), runs with a stub model, and the fetcher only against fake transports and the dry-run fixtures. JavaScript-rendered manufacturer pages give unknowns (backlog #21). Value history keeps only the original of a corrected value.
