# CI and branch protection

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. It has three jobs that run in parallel.

| Job (check name) | Runs |
|---|---|
| **Backend** | typecheck (`tsc`, including tests and `prisma/seed.ts`), ESLint, `prisma migrate deploy` plus a check that migrations match `schema.prisma`, Jest, build. Postgres (pgvector) and Redis run as service containers on `localhost`. |
| **Frontend** | typecheck, ESLint, Vitest, production build. |
| **ML** | pytest. The ML service has no typecheck or linter configured yet. |

## Required status checks

In **Settings → Branches → Branch protection rules → `main`** enable:

- **Require a pull request before merging**
- **Require status checks to pass before merging**, and select these three checks:
  - `Backend`
  - `Frontend`
  - `ML`
- **Require branches to be up to date before merging** (so the checks run against the merge result)

GitHub lists a check only after it has run at least once, so open a PR first and then add them. In the checks UI they appear as `CI / Backend (pull_request)` etc.; the name to select in branch protection is the job name (`Backend`, `Frontend`, `ML`).

## Reproducing CI locally

```bash
docker compose up -d                       # Postgres + Redis on localhost
cd backend  && npm ci && npx prisma migrate deploy && npm run typecheck && npm run lint && npm test && npm run build
cd frontend && npm ci && npm run typecheck && npm run lint && npm test && npm run build
cd ml       && pip install -r requirements.txt && python -m pytest -q
```

Backend tests use a separate Postgres schema (`?schema=test`) in the same database, so they never touch dev data. Override with `TEST_DATABASE_URL`.
