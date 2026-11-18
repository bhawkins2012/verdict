# Backlog

Issue-ready items. Each item has a problem statement, acceptance criteria and a rough size: **S** ≤ 1 day, **M** 2–4 days, **L** a week or more / needs a decision first. Item details below were checked against `main` at `ef1f0db` (before Sprint 1) unless they say otherwise; numbers are stable IDs, the table order is the priority.

## Status (updated after Sprint 1, `main` at `dceeb12`)

**Done in Sprint 1 (PR #5):** email check-in nudges (delivery, Redis resilience, new 2 weeks / 3 months / 1 year / 2 years cadence, opt-in prompt with persisted decline). Part of #8 shipped with it: the profile now has the email-reminder controls (opt-in, time zone, send hour). The "real nudge email needs legal review" part of #4 is still open.

**In progress:** #9 Email verification (Sprint 2, branch `sprint-2-email-verification`): built; real delivery unverified until the `email:smoke` run with a real Resend key. Added from Sprint 2 decisions: #12–#14.

## Priority order

| Rank | # | Item | Size | Why this rank |
|---|---|---|---|---|
| — | 9 | [Email verification](#9-email-verification) | M | Sprint 2; unblocks real nudge email |
| 1 | 4 | [Legal review: aggregation sources and real nudge email](#4-aggregation-sources-legal-and-terms-of-service-review) | M | After #9 it is the last blocker before any real email; non-engineering lead time |
| 2 | 10 | [Validate list query parameters](#10-validate-list-query-parameters) | S | A verified 500 on `main`; small |
| 3 | 11 | [Admin view of dead-lettered nudges](#11-admin-view-of-dead-lettered-nudges) | S | Needed before real sends: `FAILED` nudges are only visible in logs and `doctor.sh` |
| 4 | 1 | [Jest `forceExit`: find and fix leaked handles](#1-jest-forceexit-find-and-fix-leaked-handles) | S | Test-suite hygiene; hides real leaks |
| 5 | 2 | [Lint and typecheck the ML service](#2-lint-and-typecheck-the-ml-service) | S | Cheap; two past ML bugs would have been caught |
| 6 | 8 | [Account settings page](#8-account-settings-page) | M | Email change from #9 lands here; password change and account deletion still missing |
| 7 | 7 | [Product creation flow and better search](#7-product-creation-flow-and-better-search) | M | "Add product" button does nothing |
| 8 | 6 | [Product page and review-thread UI polish](#6-product-page-and-review-thread-ui-polish) | M | |
| 9 | 5 | [Preview deployment per PR](#5-preview-deployment-per-pr) | M | Blocked on a host decision |
| 10 | 3 | [Recommender evaluation: data and metrics strategy](#3-recommender-evaluation-data-and-metrics-strategy) | L | Design first; low urgency at current data volume |
| 11 | 12 | [Pending email change (confirm before switching)](#12-pending-email-change-confirm-before-switching) | M | Removes the remaining enumeration (409) in email change; fits with #8 |
| 12 | 13 | [Rename the email provider settings to `EMAIL_*`](#13-rename-the-email-provider-settings-to-email_) | S | Naming only; account emails now share the nudge settings |
| 13 | 14 | [Opt-in prompt follow-ups from the Sprint 2 review](#14-opt-in-prompt-follow-ups-from-the-sprint-2-review) | S | Small; one is a real gap (prompt never shown for a later-stage first review) |
| 2* | 15 | [Unverified accounts can squat an address](#15-unverified-accounts-can-squat-an-address) | M | Security; rank right after #4 (needs password reset or expiry of unverified accounts) |
| P1 | 16 | [Car seat value levers](#16-car-seat-value-levers) | S | Phase A; the category exists, needs a live generation run and approval |
| P2 | 17 | [Spec extraction from manufacturer pages](#17-spec-extraction-from-manufacturer-pages) | L | Phase A; fills lever values at scale; needs sourcing rules applied per site |
| P3 | 18 | [Licensed-search review synthesis](#18-licensed-search-review-synthesis) | L | Phase A; blocked on a licensed search provider and counsel sign-off |
| P4 | 19 | [Remove `Product.category` once the ML service reads `categoryId`](#19-remove-productcategory-once-the-ml-service-reads-categoryid) | S | Cleanup; two sources of truth for a product's category until then |

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

**Also in scope: legal review before real nudge emails.** Sprint 1 ships nudge emails with only the dry-run provider active. Before switching `NUDGE_EMAIL_PROVIDER` to `resend` in any environment that emails real users, get legal review of: consent wording and record-keeping (`emailNudgesConsentAt`), the unsubscribe flow, the sender identity and the postal address in the footer (`NUDGE_POSTAL_ADDRESS`, currently a placeholder), and applicable rules for the target markets (e.g. CAN-SPAM, GDPR/ePrivacy, CASL).

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
**Size:** M (partly done: Sprint 1 put the email-reminder controls on the profile page)

**Problem.** There is no settings page: the profile page edits demographics only. Sprint 1 adds the nudge controls (email opt-in, timezone, preferred send hour; see `docs/adr-nudges.md`) and may expose them minimally; there is still no way to change display name, email or password, or delete the account.

**Acceptance criteria**
- A settings page with sections: notifications (opt-in, timezone, send hour, consuming the Sprint 1 API), profile (display name), security (change password; signs out other sessions by revoking refresh tokens), account (delete account and its data, with confirmation).
- Timezone defaults to the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Every change is authorised to the current user only; tests cover cross-user attempts.

---

## 9. Email verification
**Size:** M · **In progress (Sprint 2)**

**Problem.** `User.emailVerified` exists but nothing ever sets it: there is no verification flow, so every user is unverified. Once nudges send real email (Sprint 1), sending to unverified addresses risks mail to typo'd or someone else's addresses, spam complaints and damage to the sending domain's reputation.

**Acceptance criteria**
- On registration (and on email change), send a signed, expiring verification link through the Sprint 1 email provider (dry-run in dev/tests).
- Verifying sets `emailVerified = true`; links are single-use and expire (e.g. 24h); resend is rate-limited.
- Nudges already require a verified address for real sends (`NUDGE_REQUIRE_VERIFIED_EMAIL=true`, decided in Sprint 1), so **production nudge email stays effectively off until this item ships.** Once verification exists, real sends go to verified users automatically; no nudge change is needed.

---

## 10. Validate list query parameters
**Size:** S

**Problem.** `GET /api/products?page=abc` returns **500** (`parseInt` gives `NaN`, which reaches Prisma); verified on `main`. `limit=-5` returns 200 with surprising results and `limit` has no upper bound. Other list routes parse query strings the same way (`req.query as Record<string, string>`).

**Acceptance criteria**
- List endpoints parse `page`/`limit`/filters with zod: integers, `page ≥ 1`, `1 ≤ limit ≤ 100`; invalid input returns **400** with a message.
- Tests for invalid values on each list endpoint; no `as Record<string, string>` casts on `req.query`.

---

## 11. Admin view of dead-lettered nudges
**Size:** S (added after Sprint 1)

**Problem.** A nudge that fails `NUDGE_MAX_ATTEMPTS` times ends `FAILED` (dead letter). Today the only signs are a log line and the count in `scripts/doctor.sh`; nobody is alerted and there is no way to inspect or retry one. Once real email is on, provider outages or bad addresses would go unnoticed.

**Acceptance criteria**
- An admin-only endpoint (and minimal page or CLI) listing `FAILED` nudges with `lastError`, attempts and user, newest first; a retry action that returns one to `PENDING` with attempts reset.
- Admin authorization defined first (there is no admin role yet): a decision recorded in an ADR.
- Tests for authorization and retry.

---

## 12. Pending email change (confirm before switching)
**Size:** M (added in Sprint 2, decision Q3)

**Problem.** `PUT /api/users/me/email` changes the address at once and answers 409 when the new address belongs to another account. That reveals that the address is registered, though only to a signed-in user who knows their password, at most 5 times an hour.

**Acceptance criteria**
- The new address is stored as pending; the account keeps its current, verified address until the link sent to the new one is confirmed.
- The response is the same whether or not the new address is taken; a taken address gets a "someone tried to use this address" notice instead of a link.
- The old address is notified when the change completes; pending changes expire with the link (24 h).

---

## 13. Rename the email provider settings to `EMAIL_*`
**Size:** S (added in Sprint 2, decision Q5)

**Problem.** Account emails (verification, notices) use the nudge settings `NUDGE_EMAIL_PROVIDER`, `NUDGE_FROM_EMAIL`, `NUDGE_POSTAL_ADDRESS` and `RESEND_API_KEY`; the names suggest they only affect nudges.

**Acceptance criteria**
- `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_POSTAL_ADDRESS` (and `RESEND_API_KEY`), with the `NUDGE_*` names still read as fallbacks for one release and a startup warning when they are used.
- `.env.example`, CLAUDE.md, the smoke-test steps and `doctor.sh` updated.

---

## 14. Opt-in prompt follow-ups from the Sprint 2 review
**Size:** S (reviewer findings on the "No thanks" prompt, accepted as deferred)

- **The prompt never shows for a product whose first review is at a later stage.** `WriteReviewPage` sets `firstReview` only for an `INITIAL` review, but the API accepts a thread that starts at a later stage. Decide whether "first review of a product" means the first review of any stage, and test it.
- **One test cannot fail:** `rejects {"nudgePromptDismissedAt": null}` in `backend/tests/nudges/api.test.ts` already passed before the field existed (the schema is `.strict()`). Keep it as a guard, but add a test that fails without the dismiss endpoint's own rules if there is a gap.
- **No test for a failed decline:** the button should come back, the error show, and the prompt stay.
- **Duplicated error message:** if both the opt-in and the decline fail, "Could not save" shows twice; after a successful decline, a short "You can turn reminders on in your profile" would help.

---

## 15. Unverified accounts can squat an address
**Size:** M (Sprint 2 reviewer finding)

**Problem.** Anyone can register `victim@example.com` with their own password; the account stays unverified indefinitely. When the real owner registers later they get the same 202 and a "someone tried to sign up" email, but cannot sign in (no password reset exists), so the address is effectively taken.

**Acceptance criteria**
- Unverified accounts with no activity expire after N days (decision needed), and/or a password-reset flow via the address takes ownership (verifying the address proves it).
- The "someone tried to sign up" email points to that recovery path.
- Tests for both; no change to the no-enumeration guarantees.

---

## 16. Car seat value levers
**Size:** S (Phase A, after `phase-a-levers`)

**Problem.** The spec leaves the car seat levers open. The `car-seats` category exists (seeded, unpublished, no levers) so a live generation run can propose candidates once an `ANTHROPIC_API_KEY` is set.

**Acceptance criteria**
- A live run for car seats (`LEVER_GEN_MODE=live`) produces 10 to 12 candidates; tokens and cost are recorded.
- An admin edits, picks and orders five, and publishes them; the approval record names the admin.
- The car seat owner survey (if run) is imported and shown next to the candidates before publishing.
- Product values for the launch car seats are entered with sources (form or CSV).

---

## 17. Spec extraction from manufacturer pages
**Size:** L (Phase A; product spec, "Lever generation and review synthesis", step 4)

**Problem.** Lever values are entered by hand or imported from CSV. The spec calls for an extraction job that reads manufacturer spec pages and manuals reached by permitted routes, stores a source link per value, and has a person spot-check a sample before publishing.

**Acceptance criteria**
- A job takes a product and a manufacturer URL, fetches only pages whose terms and robots.txt permit it (no logins, no CAPTCHA or rate-limit circumvention), and proposes values for the five levers with the exact source URL per value.
- Proposed values are not public until an admin accepts them (same rule as levers); accepted values go through the existing value validation (`toValueData`) and carry `sourceType: URL`.
- A spot-check view samples proposed values per category; the decision is recorded.
- Tests with recorded fixtures; no network in CI.

---

## 18. Licensed-search review synthesis
**Size:** L (Phase A; blocked on a provider decision and counsel)

**Problem.** The product page should show "What expert reviewers say": a short paraphrased summary per lever from expert and publisher reviews that permit it, each claim linked to its source, found through a licensed search API. Verdict stores the summary and links, never the source text.

**Acceptance criteria**
- Provider chosen whose license covers Verdict's commercial use (open decision in the spec); counsel signs off on the method before anything is public.
- A job builds the summary per product and lever with Claude; every claim links to its source; reviewer names and personal details are never stored.
- The product page shows the block only under the "What expert reviewers say" label, visually separate from Verdict reviews; unapproved summaries are never public.
- Tests with recorded fixtures; no network in CI.

---

## 19. Remove `Product.category` once the ML service reads `categoryId`
**Size:** S (cleanup after `phase-a-levers`)

**Problem.** Products now link to a `Category` row (`categoryId`), but the free-text `Product.category` stays because the ML service (`ml/main.py`, `models/recommender.py`) and the older `GET /api/products?category=` filter read it. The API keeps the string equal to the category slug on every write, so there are two sources of truth until it is removed.

**Acceptance criteria**
- The ML service filters by `categoryId` (SQL quotes `"categoryId"`), with its tests updated.
- `GET /api/products?category=` and the recommendations route filter by category slug through `categoryId`.
- A migration makes `products.categoryId` required and drops `products.category`; `migrate diff` is empty.

---

## Also noted (smaller, not yet itemized)
- `frontend/tsconfig.node.json` (the Vite config and `devServerPort.ts`) is never type-checked: `npm run typecheck`/`build` run plain `tsc`, which skips project references, and it has no Node types (`Cannot find module 'path'` on `main`). Add Node types and check it in CI.
- In CI the backend `pretest` hook runs `prisma generate` a second time after the explicit step (harmless, ~150 ms).
- Sprint 1 leftovers: the dashboard progress bar shows `TWO_WEEKS` grey on legacy threads that have a hand-written `ONE_MONTH` review (cosmetic); the frontend does not zod-validate `GET /api/config` (no zod dependency in the frontend).
- The CI Postgres service container's healthcheck still uses socket-based `pg_isready` (the dev compose file was fixed in PR #4); harmless so far because Jest's `globalSetup` migrates first and fails loudly.
- The frontend production build warns about a chunk over 500 kB; route-level code splitting would fix it.
- `npm ci` warns that ESLint 9 is no longer supported; plan the ESLint 10 upgrade.
- `npm run dev:ml` calls bare `uvicorn` and fails unless the ML virtualenv is active (CLAUDE.md, "Known gaps").
- Value levers (Phase A follow-ups): lever value history is not kept (only the current value with who/when, ADR Q11); the category page lists at most 100 products and sorts by name until Best Fit (Phase C); the one-hand-fold flag of a dimensions lever has a filter but no separate column on the product list; Swagger (`/api/docs`) does not describe the new category and admin routes yet (`docs/api.md` does).
