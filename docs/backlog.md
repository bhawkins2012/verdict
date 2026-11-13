# Backlog

Issue-ready items not scheduled for Sprint 1 (nudges). Each item has a problem statement, acceptance criteria and a rough size: **S** ≤ 1 day, **M** 2–4 days, **L** a week or more / needs a decision first. Facts below were checked against the code on `main` (`ef1f0db`); file references point at where to start.

| # | Item | Size |
|---|---|---|
| 1 | [Jest `forceExit`: find and fix leaked handles](#1-jest-forceexit-find-and-fix-leaked-handles) | S |
| 2 | [Lint and typecheck the ML service](#2-lint-and-typecheck-the-ml-service) | S |
| 3 | [Recommender evaluation: data and metrics strategy](#3-recommender-evaluation-data-and-metrics-strategy) | L |
| 4 | [Aggregation sources: legal and terms-of-service review](#4-aggregation-sources-legal-and-terms-of-service-review) | M |
| 5 | [Preview deployment per PR](#5-preview-deployment-per-pr) | M (blocked on a decision) |
| 6 | [Product page and review-thread UI polish](#6-product-page-and-review-thread-ui-polish) | M |
| 7 | [Product creation flow and better search](#7-product-creation-flow-and-better-search) | M |
| 8 | [Account settings page](#8-account-settings-page) | M |
| 9 | [Email verification](#9-email-verification) | M |
| 10 | [Validate list query parameters](#10-validate-list-query-parameters) | S |

---

## 1. Jest `forceExit`: find and fix leaked handles
**Size:** S

**Problem.** `backend/jest.config.js` sets `forceExit: true` so a hung request fails the run instead of stalling CI. Jest prints "Force exiting Jest: Have you considered using `--detectOpenHandles`" on every run, so something (likely Prisma clients from `jest.resetModules()` in `tests/rateLimit.test.ts`, supertest servers, or the Winston console transport) stays open. `forceExit` hides real leaks, including ones that would matter in production code.

**Acceptance criteria**
- `npx jest --detectOpenHandles` reports no open handles.
- `forceExit` is removed and the suite exits on its own locally and in CI, with no "Force exiting" message.
- A hung request still fails the run (per-test `testTimeout` is enough once handles are closed); demonstrate with a deliberately hanging test that is then removed.

---

## 2. Lint and typecheck the ML service
**Size:** S

**Problem.** `ml/` has no linter or type checker (CLAUDE.md, "Known gaps"). Sprint 0 found two ML bugs that static checks would have flagged earlier: dataclass instances returned to a pydantic response model, and SQL against non-existent snake_case columns.

**Acceptance criteria**
- `ruff` (lint + format check) and `mypy` (or `pyright`) configured in `ml/` (e.g. `pyproject.toml`), with new dev dependencies listed in the PR.
- Existing code passes, or each remaining exclusion is listed with a reason.
- CI `ML` job runs both before pytest; CLAUDE.md's ML lines updated (remove the "ML has none" notes).

---

## 3. Recommender evaluation: data and metrics strategy
**Size:** L (design first)

**Problem.** The seed has 3 users and 4 products (`backend/prisma/seed.ts`), so recommender changes cannot be evaluated: almost any output "looks right". Without an offline evaluation, stage weights (`ml/models/recommender.py` `STAGE_WEIGHTS`), demographic weighting and future model upgrades (ADR-009 in `docs/architecture.md`) are guesses.

**Acceptance criteria**
- An ADR (architect agent) choosing the data source(s): a synthetic generator with planted structure (user segments, products whose ratings drift over time) and/or a public ratings dataset adapted to stages, with licence noted.
- Metrics defined with a time-based split (train on earlier stages, predict later ones): precision@k / recall@k / NDCG@k, catalogue coverage, and a popularity baseline the model must beat.
- A script that produces the dataset and prints the metrics reproducibly (fixed seed); documented command.
- Decision recorded on whether metrics run in CI (and a threshold) or on demand.

---

## 4. Aggregation sources: legal and terms-of-service review
**Size:** M (mostly non-engineering)

**Problem.** The schema already models imported reviews (`AggregatedReview`, `enum AggregationSource`: AMAZON, GOOGLE, YELP, STEAM, GOODREADS, TRIPADVISOR, MANUAL), and the README promises external review aggregation. No scraper or importer exists yet. Scraping several of these sites likely violates their terms of service, and storing or displaying their review text has copyright and attribution implications.

**Acceptance criteria**
- A written review per source: official API availability and terms, what may be stored (text vs. score vs. link only), retention limits, attribution requirements, rate limits, and cost.
- A decision per source: allowed via API / link-out only / not used. Reviewed by whoever owns legal risk.
- No scraper or importer code is merged before this exists; the schema is adjusted if some fields cannot legally be stored.

---

## 5. Preview deployment per PR
**Size:** M, **blocked on a host decision from the product owner**

**Problem.** Reviewers can only see UI changes by checking out a branch and running three services plus Postgres and Redis. PR #2–#4 each needed manual browser verification.

**Decision needed.** Hosting: e.g. Render / Railway / Fly.io (all three services + Postgres + Redis in one place), or a split (static frontend on Vercel/Netlify/Cloudflare Pages, API + ML + databases elsewhere). Trade-offs: cost per preview, cold starts, database per preview vs. shared, secrets handling.

**Acceptance criteria (after the decision)**
- Every PR gets a URL posted on the PR; it is torn down on close.
- Each preview has its own database (migrated with `prisma migrate deploy` and seeded), never production data.
- No secrets in the repo; preview secrets in the host's secret store; email provider forced to dry-run in previews.
- `TRUST_PROXY` set correctly for the host's proxy chain.

---

## 6. Product page and review-thread UI polish
**Size:** M

**Problem.** `frontend/src/pages/ProductPage.tsx` and `ReviewThreadPage.tsx` have not had a UX pass since the MVP; Sprint 0 only verified they render without errors. One known rough edge: opening `/products/:id/thread` for a product the user has not reviewed hits a 404 from `GET /api/reviews/thread/:productId` (seen during the Sprint 0 browser check); what the page shows in that state was not checked.

**Acceptance criteria**
- An audit list (screenshots) of both pages on desktop and a 375px-wide viewport, agreed before changes.
- Loading, empty, error and "no thread yet" states are explicit and offer the next action (e.g. "Write your first review").
- Basic accessibility: headings in order, interactive elements reachable by keyboard, labelled form controls, sufficient contrast.
- Verified in a browser (CLAUDE.md Definition of Done #5).

---

## 7. Product creation flow and better search
**Size:** M

**Problem.** The "Add product" button on Discover does nothing: `frontend/src/pages/DiscoverPage.tsx:34-36` has no handler. The API already supports it (`POST /api/products`, zod-validated, duplicate Amazon ASIN → 409). Search is wired but basic: a case-insensitive substring match on name/brand/description (`backend/src/routes/products.ts`), sent on every keystroke with no debounce.

**Acceptance criteria**
- "Add product" opens a form (name, brand, category, optional fields) with client-side validation matching the API; on success it navigates to the new product; 409 and validation errors are shown inline.
- Before creating, likely duplicates are suggested (same name/brand), to limit duplicate products.
- Search input is debounced; empty results offer "Add this product".
- Tests for the form; verified in a browser.

---

## 8. Account settings page
**Size:** M (depends on Sprint 1)

**Problem.** There is no settings page: the profile page edits demographics only. Sprint 1 adds the nudge controls (email opt-in, timezone, preferred send hour; see `docs/adr-nudges.md`) and may expose them minimally; there is still no way to change display name, email or password, or delete the account.

**Acceptance criteria**
- A settings page with sections: notifications (opt-in, timezone, send hour, consuming the Sprint 1 API), profile (display name), security (change password; signs out other sessions by revoking refresh tokens), account (delete account and its data, with confirmation).
- Timezone defaults to the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Every change is authorised to the current user only; tests cover cross-user attempts.

---

## 9. Email verification
**Size:** M

**Problem.** `User.emailVerified` exists but nothing ever sets it: there is no verification flow, so every user is unverified. Once nudges send real email (Sprint 1), sending to unverified addresses risks mail to typo'd or someone else's addresses, spam complaints and damage to the sending domain's reputation.

**Acceptance criteria**
- On registration (and on email change), send a signed, expiring verification link through the Sprint 1 email provider (dry-run in dev/tests).
- Verifying sets `emailVerified = true`; links are single-use and expire (e.g. 24h); resend is rate-limited.
- Decision recorded (with the product owner) on whether nudges require a verified address; enforced in the nudge sender if so.

---

## 10. Validate list query parameters
**Size:** S

**Problem.** `GET /api/products?page=abc` returns **500** (`parseInt` gives `NaN`, which reaches Prisma); verified on `main`. `limit=-5` returns 200 with surprising results and `limit` has no upper bound. Other list routes parse query strings the same way (`req.query as Record<string, string>`).

**Acceptance criteria**
- List endpoints parse `page`/`limit`/filters with zod: integers, `page ≥ 1`, `1 ≤ limit ≤ 100`; invalid input returns **400** with a message.
- Tests for invalid values on each list endpoint; no `as Record<string, string>` casts on `req.query`.

---

## Also noted (smaller, not yet itemized)
- The CI Postgres service container's healthcheck still uses socket-based `pg_isready` (the dev compose file was fixed in PR #4); harmless so far because Jest's `globalSetup` migrates first and fails loudly.
- The frontend production build warns about a chunk over 500 kB; route-level code splitting would fix it.
- `npm ci` warns that ESLint 9 is no longer supported; plan the ESLint 10 upgrade.
- `npm run dev:ml` calls bare `uvicorn` and fails unless the ML virtualenv is active (CLAUDE.md, "Known gaps").
