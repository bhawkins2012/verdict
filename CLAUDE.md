# Verdict

Longitudinal product-review platform. Users review a product at stages (initial, 1 week, 2 weeks, 1 month, … 2 years); the app computes **drift** (how opinion changed) and recommends products using stage-weighted collaborative filtering. Design rationale lives in `docs/architecture.md`; CI in `docs/ci.md`.

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
- Data model (`backend/prisma/schema.prisma`): `User` → `ReviewThread` (one per user+product) → `Review` (one per stage; **unique on `(threadId, stage)`**). `ReviewThread.driftScore = latest − initial score` by stage order; `Product.driftScoreAvg` averages its threads. `Nudge` rows schedule the next stage prompt.
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
| Apply migrations | `npm run db:deploy` (= `prisma migrate deploy`) |
| Create a migration | `cd backend && npx prisma migrate dev --name <name>` in an **interactive** terminal, then commit `prisma/migrations/` |
| Seed | `npm run db:seed` |
| Prisma Studio | `npm run db:studio` |

Demo login after seeding: `alice@example.com` / `password123` (also `bob@…`, `carol@…`). API docs: `http://localhost:3001/api/docs`.

## Environment

- **One env template, localhost only.** `backend/.env.example` is a working dev default (credentials match `docker-compose.yml`); `cp backend/.env.example backend/.env`. No hostname patching or `sed`. `.env` files are gitignored; never commit one.
- Devcontainer/Codespaces uses Docker-in-Docker and the same `localhost` URLs. Lifecycle split (`.devcontainer/devcontainer.json`):
  - `onCreateCommand` runs `install-deps.sh`: dependency installs only.
  - `postStartCommand` runs `start.sh`: `docker compose up -d --wait`, then a **real Postgres readiness probe** (`scripts/wait-for-postgres.js`: connect + auth + `SELECT 1` with `backend/.env`'s `DATABASE_URL`, backoff up to 90s), then `migrate deploy` and the seed, each with 3 bounded attempts (5s, 15s backoff). The seed only ever runs against an empty database; a seed that fails after writing data is reported as a partial seed, not retried or skipped.
  - `start.sh` writes its outcome to `.devcontainer/last-start.log` (gitignored). A hook it adds to `~/.bashrc` and `postAttachCommand` print it in every new terminal, so a failed start cannot go unnoticed.
  - **Both scripts always exit 0**, printing a clear summary of what failed, so a flaky pull/install can never put the codespace into recovery mode. If the summary reports problems, run `bash scripts/doctor.sh`, fix the cause, and re-run `bash .devcontainer/start.sh`.
  - The base image is pinned to `javascript-node:22-bookworm` and the docker-in-docker feature uses `"moby": false`. The floating `22` tag moved to Debian trixie, where the feature's default Moby install aborts and the container fails to build.
- **`TRUST_PROXY`** (backend, default `1`) is how many reverse-proxy hops Express trusts for `X-Forwarded-For`; it decides `req.ip` and therefore the per-client rate-limit bucket. Set it to the real number of hops in front of the API (the Codespaces proxy and a typical single load balancer are 1; direct connections are 0). Too low puts every user in one bucket and makes `express-rate-limit` log `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`; too high lets clients spoof their IP. **Never `true`**: `parseTrustProxy` (`backend/src/lib/trustProxy.ts`) refuses it and match-everything subnets at startup. `RATE_LIMIT_MAX` (default 200 per 15 min) exists mainly so tests can use a small limit.
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
- **Consent:** email is opt-in (`users.emailNudgesEnabled`, default `false`). After a user's first `INITIAL` review of each product the thread page shows an unchecked toggle whose label is the API's `consentCopy` (checking it also saves the browser time zone), until the user opts in (ever: `users.emailNudgesFirstEnabledAt` is set on the first opt-in and never cleared, so opting out later, including with the unsubscribe link, does not bring it back) or declines. "No thanks" calls `POST /api/users/me/nudge-prompt/dismiss`, which sets `users.nudgePromptDismissedAt`; the prompt never reappears. Profile → Email reminders stays the way to change the choice later, and opting in or out there does not clear the decline. Users who are opted out, or unverified while a real provider and `NUDGE_REQUIRE_VERIFIED_EMAIL=true` are in use, get the check-in in-app only. Nothing verifies email yet (backlog #9), so **real production email is effectively off** until that ships; real sending also needs legal review first (backlog #4).
- **Unsubscribe** links are HMAC-signed with `UNSUBSCRIBE_SECRET` (dedicated, not the JWT secrets), work without login, and need a POST to take effect (the GET shows a confirm page; mail scanners prefetch links). Emails carry `List-Unsubscribe` and `List-Unsubscribe-Post`.
- **Env vars** (backend, see `.env.example`): `NUDGE_EMAIL_PROVIDER` (`console` default = dry run, or `resend`), `RESEND_API_KEY`, `NUDGE_FROM_EMAIL`, `NUDGE_POSTAL_ADDRESS` (the last three required with `resend`; startup fails otherwise), `UNSUBSCRIBE_SECRET` (required in production), `NUDGE_REQUIRE_VERIFIED_EMAIL` (default `true`), `NUDGE_DAILY_CAP` (1), `NUDGE_MAX_ATTEMPTS` (5), `NUDGES_ENABLED` (true).
- **Dry-run provider** (default): logs each email and keeps the last 50 in memory; nothing leaves the machine. See them with `GET /api/nudges/dev/outbox`.
- **Trigger a nudge manually in dev** (dev routes exist only when `NODE_ENV` is `development` or `test`; 404 otherwise, including staging or unset): log in, find a nudge id (`GET /api/nudges`, or Prisma Studio for one not yet due), then `POST /api/nudges/:id/send-now` with your bearer token. It makes the nudge due now and runs the real claim-and-send path inline (ignoring the daily cap and send hour), then returns the outcome. Your account must have email reminders on (Profile → Email reminders) to get an email rather than an in-app-only check-in.
- **Resend is unverified**: `providers/resend.ts` follows Resend's docs but has not been run against the real API. To verify: set `NUDGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY` (Codespaces secret or `backend/.env`), `NUDGE_FROM_EMAIL` (`onboarding@resend.dev` works only to your own Resend account address until a domain is verified), `NUDGE_POSTAL_ADDRESS`, `NUDGE_REQUIRE_VERIFIED_EMAIL=false` for the test user only in a dev environment, then send-now.

## Conventions

- **TypeScript is strict. No `any`, `@ts-ignore` or `@ts-expect-error`**; the ESLint config enforces `no-explicit-any`. Validate external data (HTTP bodies, ML responses) with zod and derive types from the schema.
- Backend errors: `throw new AppError(status, message)` in handlers. `express-async-errors` is imported first in `app.ts` so async throws reach `errorHandler`; keep that import before any router.
- Logging: Winston takes `(message, meta)`: `logger.info('Nudge scheduled', { nudgeId })`. Never pino-style `(meta, message)`.
- Database invariants belong in the schema (unique constraints), not only in route pre-checks. Pre-checks are for friendly errors; map `P2002` to a 409.
- Never spread an external object into a Prisma `data` block; pass fields explicitly.
- The dev script keeps `--transpile-only` for speed; `npm run typecheck` is the source of truth for types.
- Frontend API calls go through `src/lib/api.ts`. Auth endpoints (`/auth/login`, `/auth/register`) return 401 for bad credentials and must not trigger the session-refresh flow.
- ML: return plain dicts/pydantic models from endpoints, not dataclass instances; SQL must quote Prisma's camelCase columns (`"userId"`).
- Commits are small and single-purpose; bug fixes ship with a regression test that fails without the fix.

## Agents

Project subagents live in `.claude/agents/`. Their tool lists limit which tools they get, not which paths they touch; the path rules are in each definition.

- **architect**: before changing the schema, an API contract, a job or a service boundary; writes ADRs/designs in `docs/` only.
- **qa**: after implementing a feature or fix; writes and runs tests (test files only) and mutation-checks every fix.
- **reviewer**: before opening or merging a PR; read-only review of the diff against this file (logic, security, missing tests, unverified claims).

## Definition of done

A change is done when, locally and in CI (`Backend`, `Frontend`, `ML` checks green):

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass for every package you touched.
2. New behavior and bug fixes have tests; for a fix, the test fails without it.
3. Schema changes include a committed migration; `prisma migrate diff` against the schema is empty (CI checks this).
4. No new `any`/suppressions, no committed `.env`, no new dependency that isn't called out in the PR description.
5. UI changes were exercised in a browser, not just by tests.
6. Docs (`README.md`, `docs/`, this file) are updated if commands, env vars or architecture changed.

## Known gaps

- The ML service has no typecheck or linter.
- Nudges: real email delivery is unverified (no Resend key yet) and effectively off in production until email verification ships (backlog #9). There is no admin view of dead-lettered (`FAILED`) nudges beyond the logs.
- `npm run dev:ml` calls bare `uvicorn`; it fails if the ML virtualenv isn't active.
- Jest runs with `forceExit` so a hung request fails the run instead of stalling; open handles haven't been audited.
