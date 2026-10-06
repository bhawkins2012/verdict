# Verdict

Longitudinal product-review platform. Users review a product at stages (initial, 1 week, 1 month, … 2 years); the app computes **drift** (how opinion changed) and recommends products using stage-weighted collaborative filtering. Design rationale lives in `docs/architecture.md`; CI in `docs/ci.md`.

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
| First-time setup | `bash scripts/setup.sh` (or let the devcontainer's `.devcontainer/start.sh` do it) |
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
- Devcontainer/Codespaces uses Docker-in-Docker and the same `localhost` URLs.
- Always use `prisma migrate deploy` in scripts and CI. `migrate dev` is interactive and only for authoring migrations.
- A database created earlier with `prisma db push` has no migration history, so `migrate deploy` fails with `P3005`. Recreate it (`docker compose down -v`) or run `npx prisma migrate resolve --applied 20260101000000_init` once.
- Backend tests use a separate Postgres schema (`?schema=test`) in the same database and apply migrations in Jest `globalSetup`. Override with `TEST_DATABASE_URL`. They need Postgres but not Redis or the ML service (both mocked).
- Wait for services with `node scripts/wait-for-port.js <host> <port>`, not `pg_isready` (not installed in the devcontainer).

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
- Nudges: `scheduleNudges` writes the DB row before enqueueing, so if Redis is down the nudge stays `PENDING` and is never delivered (the "cron fallback" in its comment doesn't exist). Completing a later stage doesn't cancel earlier pending nudges.
- `npm run dev:ml` calls bare `uvicorn`; it fails if the ML virtualenv isn't active.
- Jest runs with `forceExit` so a hung request fails the run instead of stalling; open handles haven't been audited.
