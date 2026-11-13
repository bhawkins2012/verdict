# ADR: Nudge delivery, correctness and Redis resilience

**Status:** Proposed (awaiting approval; nothing implemented)
**Supersedes / fills:** `docs/architecture.md` ADR-005 (nudge storage, refined here) and ADR-010 (notification channel: email chosen here; push/SMS out of scope).

## 1. Context: what the code does today (`main` @ `ef1f0db`)

| Area | Today | Problem |
|---|---|---|
| Delivery | `backend/src/jobs/nudgeWorker.ts` marks a nudge `SENT` and logs; the comment says `TODO: Send actual notification`. | Nothing is ever delivered. |
| Scheduling | `backend/src/jobs/nudgeScheduler.ts` creates a nudge after every review, due `delayMs` after **now** (chained: +7d, +23d, +60d, +90d, +183d, +365d). | A late review shifts every later stage. Nothing stops duplicate nudges for the same stage (no unique constraint; re-scheduling inserts again). |
| Durability | DB row is written first, then a BullMQ delayed job; if Redis is down the job is lost and the comment promises a "cron fallback" that does not exist. | A Redis outage silently drops nudges (CLAUDE.md "Known gaps"). |
| Lifecycle | Submitting a review never touches nudges. `POST /api/nudges/:id/skip` sets `SKIPPED`. | Completed stages keep showing as pending; earlier nudges are never cancelled. |
| In-app list | `GET /api/nudges` returns **all** `PENDING` nudges, including ones due months from now; the dashboard shows them as "waiting for your update". Once the worker marks one `SENT` it disappears from the list. | Wrong items shown; delivered items vanish before the user acts. |
| Redis config | Both jobs build the connection from `host` and `port` only. | A Redis URL with a password or DB index is silently ignored. |
| Users | No email preference, timezone or send hour. `emailVerified` is never set (no verification flow). | No consent model; no local-time sending. |
| Deep link | Dashboard links to `/products/:id/review?stage=&nudgeId=`; `WriteReviewPage` reads `stage` and ignores `nudgeId`. | Fine: completion is keyed on the stage server-side (D4), so `nudgeId` is informational. |

Nothing above contradicts the requested plan; ADR-005 already chose "DB as source of truth, Redis for delivery", which this ADR keeps and makes real.

## 2. Decisions

### D1. Delivery: provider interface, Resend + console (dry-run)

```ts
interface EmailMessage {
  to: string; subject: string; text: string; html: string
  headers: Record<string, string>        // List-Unsubscribe, List-Unsubscribe-Post
  idempotencyKey: string                 // "nudge/<nudgeId>"
}
interface EmailProvider {
  readonly name: 'console' | 'resend'
  send(message: EmailMessage): Promise<{ providerMessageId: string }>
}
class EmailProviderError extends Error { retryable: boolean; status?: number }
```

- **`ResendProvider`** calls `POST https://api.resend.com/emails` with `fetch` (Node 22 built-in), `Authorization: Bearer $RESEND_API_KEY`, an `Idempotency-Key` header, and a 10 s timeout; the response is validated with zod. **No SDK, so no new dependency.** Errors are classified: network/timeout, 429 and 5xx → `retryable: true`; other 4xx (invalid recipient, unverified domain, bad key) → `retryable: false`.
- **`ConsoleProvider`** (dry-run) logs the recipient, subject and links with Winston, never calls the network, and keeps the last 50 messages in an in-memory outbox that a dev-only route exposes. It is the **default** (`NUDGE_EMAIL_PROVIDER` unset).
- Tests inject a mock provider; no test touches the network.
- If `NUDGE_EMAIL_PROVIDER=resend` and `RESEND_API_KEY` or `NUDGE_FROM_EMAIL` is missing, the API **fails at startup** with a clear message (like `TRUST_PROXY=true` does), rather than silently not sending.

**Getting and setting the key** (never committed):
1. Create a Resend account; add a sending domain you control and publish the DNS records it gives you (SPF, DKIM). Until a domain is verified, Resend only lets you send from `onboarding@resend.dev` to your own account address, which is enough for a first real test.
2. Create an API key with **sending access only**, restricted to that domain.
3. Local: put `RESEND_API_KEY=...`, `NUDGE_EMAIL_PROVIDER=resend` and `NUDGE_FROM_EMAIL="Verdict <reminders@your-domain>"` in `backend/.env` (gitignored). Codespaces: add `RESEND_API_KEY` as a **Codespaces secret** for this repository (GitHub → Settings → Codespaces → Secrets); it arrives as an environment variable and env vars win over `.env`. Production: the host's secret store.

*Alternatives considered:* the `resend` npm SDK (convenient, but a dependency for one HTTP call); SMTP via `nodemailer` (provider-agnostic, but another dependency and weaker error typing); AWS SES (cheaper at scale, heavier setup). The interface keeps any of these a later swap.

### D2. Source of truth: the DB, with a reconciler and an atomic send-claim

**The DB decides what should be sent; Redis only decides when a worker wakes up.** Losing every Redis job must delay delivery, never lose or duplicate it.

**Send-claim (two workers cannot both send).** A worker may only send after winning a conditional update, inside a transaction holding a per-user advisory lock (`pg_advisory_xact_lock`, keyed by user) so the daily cap (D5) is race-free:

```sql
UPDATE nudges
   SET status = 'SENDING', "claimedAt" = now()
 WHERE id = $1 AND status = 'PENDING' AND "sendAt" <= now()
-- rowcount 1 = this worker owns the send; 0 = someone else did, or it is not due: do nothing
```

Postgres re-evaluates the `WHERE` under the row lock, so of two concurrent claimers exactly one gets rowcount 1 (implemented with Prisma `updateMany`, checking `count`). After the provider call, the owner sets `SENT` or schedules a retry (D7). Before calling the provider, the owner re-checks that the stage has not been reviewed meanwhile, that the user is still opted in, and the cap; if any check fails it records the outcome without sending.

**Crash after sending, before recording `SENT`.** The row is stuck in `SENDING`. The reconciler returns rows claimed more than 10 minutes ago to `PENDING`, so they are retried. The retry reuses the same `Idempotency-Key` (`nudge/<id>`), which Resend uses to drop duplicates for 24 hours. The residual duplicate risk is therefore a crash *and* a recovery more than 24 h later. *Unverified until a key is available:* Resend's idempotency behavior is taken from its documentation.

**BullMQ jobs** use `jobId = nudge:<id>:<sendAt epoch ms>`, so changing `sendAt` (snooze, retry, cap deferral) creates a new job. An old job that fires early simply loses the claim (`sendAt` is in the future) and does nothing. BullMQ `attempts: 1`, because retries live in the DB, not in two places. Only nudges due within 24 h are enqueued; later ones are picked up by later reconciler runs, which keeps Redis small and avoids churn.

**Reconciler**: runs at API start and every 5 minutes in every API instance. Every step is idempotent, so running in parallel is safe; the claim guarantees no double send.
1. `SENDING` rows with `claimedAt` older than 10 min → `PENDING`.
2. `PENDING` rows with `sendAt ≤ now + 24h` and no live job (`queue.getJob(jobId)` missing, or not `delayed`/`waiting`/`active`) → enqueue with `delay = max(0, sendAt − now)`.
3. **Redis unavailable** (enqueue throws or `PING` fails): process due nudges inline in the reconciler, through the same claim, oldest first, in batches of 50. Delivery continues without Redis, at up to a 5-minute delay.
4. Hourly: re-plan threads whose active nudge may have been superseded by time passing (D3).

*Alternatives considered:* (a) DB polling only, with no BullMQ (simplest and fully Redis-independent, but drops the existing queue the plan keeps, and loses sub-minute timing); (b) trusting BullMQ persistence (fails the Redis-outage goal); (c) a `SELECT … FOR UPDATE SKIP LOCKED` batch claimer (equivalent safety, but more code than the single-row conditional update for our volume).

### D3. Schedule anchoring

`anchor = thread.purchasedAt ?? thread.startedAt`. A stage is due at a fixed calendar offset from the anchor, never from the previous review:

| Stage | Due at |
|---|---|
| `ONE_WEEK` | anchor + 7 days |
| `ONE_MONTH` | anchor + 1 month |
| `THREE_MONTHS` | anchor + 3 months |
| `SIX_MONTHS` | anchor + 6 months |
| `ONE_YEAR` | anchor + 1 year |
| `TWO_YEARS` | anchor + 2 years |

`INITIAL` is the first review, so it gets no nudge. `CUSTOM` is ad hoc, so it gets no nudge and doesn't affect planning. The old chained delays add up to almost the same offsets for a punctual user (7, 30, 90, 180, 363, 728 days), so on-time behavior barely changes.

`purchasedAt` is optional and user-supplied (on the first review), because `startedAt` is "first review written", which is wrong when a user starts tracking a product they have owned for months.

**Planner.** One pure function computes the single active nudge per thread from the anchor, the reviewed stages, existing nudge rows and `now`:
- **Candidates:** scheduled stages later than the latest reviewed stage that have no review and no `SKIPPED` row.
- **Several stages already overdue** (due ≤ now): target only the **latest** overdue stage, the most relevant one, and mark earlier active nudges `CANCELLED` with reason `SUPERSEDED`. Example: a user wrote only `INITIAL` four months ago, so `ONE_WEEK`, `ONE_MONTH` and `THREE_MONTHS` are all overdue: one nudge, for `THREE_MONTHS`.
- **Nothing overdue:** target the earliest upcoming candidate.
- **A late user** keeps the anchored schedule. A `ONE_MONTH` review written on day 50 still leaves `THREE_MONTHS` due on day 90, not day 110. A nudge stays relevant until the next stage becomes due, then is superseded (hourly sweep, D2 step 4).
- **Minimum gap:** the target's send time is no earlier than **7 days after the user's latest review**, so we never ask again right after they answered.
- `sendAt` = the first time ≥ max(dueAt, latest review + 7 days, now) that falls on the user's preferred hour in their timezone (D5).

The planner runs after a review is submitted (D4), after skip or snooze, from the hourly sweep, and once for every thread after the migration. It is idempotent: same inputs, same rows.

*Alternatives considered:* chaining from the previous review (today's behavior: it drifts later and later for late users); sending every overdue stage (spammy and confusing).

### D4. Lifecycle

| From | Event | To |
|---|---|---|
| (none) | planner targets this stage | `PENDING` |
| `PENDING` | due, and a worker wins the claim | `SENDING` |
| `SENDING` | provider accepted the email | `SENT` |
| `SENDING` | user opted out at send time | `SENT` with `channel = IN_APP` (no provider call) |
| `SENDING` | daily cap reached | `PENDING`, `sendAt` = next day's send hour |
| `SENDING` | retryable error, attempts left | `PENDING`, `sendAt` = now + backoff |
| `SENDING` | permanent error, or last attempt failed | `FAILED` (dead letter) |
| `SENDING` | claim older than 10 min (crash) | `PENDING` (reconciler) |
| `PENDING`, `SENDING`, `SENT`, `FAILED` | review submitted for this stage | `COMPLETED` (`REVIEW_SUBMITTED`) |
| `PENDING`, `SENDING`, `SENT`, `FAILED` | review for a later stage, or a later stage became due | `CANCELLED` (`SUPERSEDED`) |
| `PENDING`, `SENT`, `FAILED` | user skips | `SKIPPED` (`USER_SKIPPED`) |
| `PENDING`, `SENT` | user snoozes (max 3) | `PENDING`, `sendAt` after `snoozedUntil` |

`COMPLETED`, `CANCELLED` and `SKIPPED` are terminal.

- **Review submitted for stage S** (same database transaction as the review insert): the nudge for S, in any non-terminal state, becomes `COMPLETED` with `completedAt`. Every non-terminal nudge for an earlier stage becomes `CANCELLED` with reason `SUPERSEDED`. Then the planner creates or updates the next nudge, and it is enqueued after commit. If enqueueing fails, the reconciler picks it up; if the process dies after commit, the planner sweep repairs it.
- **Skip** (existing endpoint, now also allowed on `SENT`/`FAILED`): `SKIPPED`. No email for that stage, ever. The planner moves on to the next stage.
- **Snooze** (new, `POST /api/nudges/:id/snooze { days: 7 | 30 }`): sets `snoozedUntil` and moves `sendAt` to the next send hour after it; status returns to `PENDING` even if it was `SENT`, giving at most one more email. Limited to 3 snoozes per nudge. A snooze cannot outlive relevance: if the next stage becomes due first, the sweep supersedes it.
- **In-app list** (`GET /api/nudges`, semantics changed): nudges that are **due** (`scheduledFor ≤ now`), not snoozed, and in `PENDING`, `SENDING`, `SENT` or `FAILED`. Delivery status doesn't hide a check-in. The dashboard count uses the same rule.
- Uniqueness: **one nudge row per (thread, stage)**, enforced by a unique index. State changes update that row; nothing inserts a second one.

### D5. User controls

- **Email opt-in:** `users.emailNudgesEnabled`, **default `false`** for new and existing users, with `emailNudgesConsentAt` recording when it was turned on. Why off:
  - nobody has consented so far;
  - there is no email verification yet (backlog #9), so mail could reach typo'd addresses;
  - consent-first protects the sending domain's reputation and keeps us clear of opt-in rules (e.g. GDPR/ePrivacy);
  - users who never opt in still get **in-app** check-ins.

  The product asks at the natural moment: a "Remind me by email" toggle when someone starts tracking a product, plus the setting on the profile page.
- **Unsubscribe without login:**
  - The token is `base64url(HMAC-SHA256(NUDGE_SIGNING_SECRET, "unsubscribe:v1:" + userId))`, compared with `crypto.timingSafeEqual`.
  - It doesn't expire, because old emails must keep working; rotating the secret revokes every link.
  - Each email links to `GET /api/nudges/unsubscribe?u=<userId>&t=<token>`, a tiny page with a confirm button. A plain GET doesn't unsubscribe, because mail scanners prefetch links. The button's POST to the same URL performs it.
  - Headers: `List-Unsubscribe: <that URL>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), which Gmail and Yahoo require of bulk senders.
  - A tampered or mismatched token returns 400 and changes nothing.
- **Timezone and send hour:** `users.timezone` (IANA name, validated with `Intl.DateTimeFormat`, default `UTC`; the UI pre-fills the browser's zone when the user opts in) and `users.nudgeSendHour` (0–23, default **9** local). Local-time math uses `Intl`, with tests across DST changes (see open question Q9).
- **Daily cap:** at most `NUDGE_DAILY_CAP` (default **1**) nudge emails per user per local calendar day. It is checked under the per-user advisory lock and counts both `SENT` and in-flight `SENDING`, so two workers can't both squeeze in. A nudge over the cap is **deferred** to the next day's send hour, oldest due first. A deferral is not a failed attempt. In-app check-ins are not capped.
- **API:** `GET /api/users/me/notification-settings`, plus `PUT` with a zod-validated body.

### D6. Email content

Plain and short, no images, no tracking pixels, no click-tracking redirects (Resend open/click tracking stays disabled for the domain). Text and a minimal HTML part with the same content. Every user-supplied value (display name, product name) is HTML-escaped.

```
Subject: How is your {product name} holding up?

Hi {display name or username},

It's been {one month} since you started using {product name}. Has your opinion changed?

Write your {1 month} review:
{FRONTEND_URL}/products/{productId}/review?stage={STAGE}&nudgeId={nudgeId}

You're getting this because you turned on review reminders in Verdict.
Stop these emails: {unsubscribe URL}
```

### D7. Failure handling

| Outcome | Result |
|---|---|
| Provider OK | `SENT`, with `sentAt` and `providerMessageId` |
| Retryable error (network, timeout, 429, 5xx) and `attempts` < `NUDGE_MAX_ATTEMPTS` (default **5**) | back to `PENDING`, `sendAt = now + backoff[attempts]` with backoff **1 min, 5 min, 30 min, 2 h**, plus `lastError`/`lastAttemptAt` |
| Retryable error on the last attempt, or any permanent error (invalid recipient, unverified sender, bad key) | `FAILED` (dead letter), with `lastError` |
| Skipped before calling the provider (review already submitted, user opted out, cap reached) | `COMPLETED` / in-app only / deferral; **not** counted as an attempt |

- `attempts` is incremented only when the provider is called.
- `FAILED` nudges stay visible in-app.
- Each dead letter is logged at `error` level with the nudge id and reason, and `scripts/doctor.sh` reports the count.
- A bad API key fails every send permanently, so the logs show it on the first nudge rather than after five retries.

### D8. Schema changes: migration plan

One new migration, authored with `prisma migrate diff` and hand-edited for the backfill and dedupe. It is applied **only** with `prisma migrate deploy`, and CI's drift check proves it matches `schema.prisma`.

1. `enum NudgeStatus`: add `SENDING` and `FAILED`. The migration itself doesn't use the new values: Postgres can't use an enum value in the transaction that added it.
2. New `enum NudgeEndReason { SUPERSEDED, REVIEW_SUBMITTED, USER_SKIPPED }` and `enum NudgeChannel { EMAIL, IN_APP }`.
3. `nudges`:
   - add `sendAt TIMESTAMP(3)`, backfilled from `scheduledFor`, then `NOT NULL`;
   - add `attempts INT NOT NULL DEFAULT 0`, `lastAttemptAt`, `lastError TEXT`, `claimedAt`, `providerMessageId TEXT`, `channel NudgeChannel`, `snoozedUntil`, `snoozeCount INT NOT NULL DEFAULT 0`, `endedReason NudgeEndReason`, `createdAt DEFAULT now()`, `updatedAt`;
   - `scheduledFor` keeps its name and now means **due date** (anchored).
4. **Dedupe before the unique index:** for each `(threadId, targetStage)` with more than one row, keep the newest by `scheduledFor` (then `id`) and delete the rest. Then `CREATE UNIQUE INDEX` on `(threadId, targetStage)`. Replace the `(scheduledFor, status)` index with `(status, sendAt)`.
5. `users`: add `emailNudgesEnabled BOOLEAN NOT NULL DEFAULT false`, `emailNudgesConsentAt`, `timezone TEXT NOT NULL DEFAULT 'UTC'`, `nudgeSendHour INT NOT NULL DEFAULT 9`. The 0–23 range is validated by zod in the API (Prisma has no CHECK constraints).
6. `review_threads`: add `purchasedAt TIMESTAMP(3)` (nullable).
7. **After deploy:** the planner runs once over every thread, which anchors existing `PENDING` nudges and supersedes stale ones. It is idempotent and safe to repeat.

It will be verified on an empty database, on a seeded database, and on a database with deliberately duplicated nudges.

### D9. Configuration (backend env vars)

| Variable | Default | Purpose |
|---|---|---|
| `NUDGE_EMAIL_PROVIDER` | `console` | `console` (dry-run) or `resend` |
| `RESEND_API_KEY` | none | required for `resend`; a secret, never committed |
| `NUDGE_FROM_EMAIL` | none | required for `resend`, e.g. `Verdict <reminders@your-domain>` |
| `NUDGE_SIGNING_SECRET` | dev value in `.env.example` | HMAC key for unsubscribe links; required, ≥ 32 chars; production must override |
| `NUDGE_DAILY_CAP` | `1` | emails per user per local day |
| `NUDGE_MAX_ATTEMPTS` | `5` | before `FAILED` |
| `NUDGES_ENABLED` | `true` (`false` in tests) | kill switch for the worker and reconciler |
| `FRONTEND_URL` | existing | base for the deep link and unsubscribe URL |

**Manual trigger in dev:** `POST /api/nudges/:id/send-now`. It is authenticated, limited to your own nudge, and not mounted when `NODE_ENV=production`. It makes the nudge due now and runs the same claim-and-send path inline, ignoring the daily cap and send hour (documented). `GET /api/nudges/dev/outbox` shows what the console provider "sent".

## 3. How the requested tests map (Step 3)

| Requirement | Test idea (provider mocked, real Postgres test schema) |
|---|---|
| Reconciler idempotency | Run it twice: same jobs, same rows; a missing job is re-created exactly once |
| No double send, concurrent workers | Two `processNudge(id)` calls in parallel → provider called once |
| Supersession | Review for `THREE_MONTHS` cancels a pending `ONE_MONTH` nudge |
| Completion on submit | Review for S marks S's nudge `COMPLETED`, in the same transaction |
| Anchoring when late | `ONE_MONTH` reviewed on day 50 → `THREE_MONTHS` due day 90 |
| Overdue collapse | Only `INITIAL` reviewed, 4 months ago → one nudge, `THREE_MONTHS` |
| Unsubscribe token | Valid token unsubscribes; tampered token / wrong user / missing → 400, nothing changes; GET alone doesn't unsubscribe |
| Opt-out respected | Opted-out user: no provider call, nudge still visible in-app |
| Daily cap | Two due nudges for one user, cap 1 → one sent, the other deferred to the next local send hour, including under concurrency |
| Retry and dead letter | Retryable error → `PENDING` with backoff; 5th failure → `FAILED`; permanent error → `FAILED` at once |
| Redis down | Enqueue throws → reconciler sends due nudges inline, once |
| Timezone | Next 09:00 in `America/New_York` across both DST changes, and in `Asia/Kolkata` (half-hour offset) |

Every fix gets a mutation check: reintroduce the bug and confirm a test fails.

## 4. Out of scope (this sprint)

Push and SMS (ADR-010 remains open for them), digest emails, an admin UI for dead letters, email verification (backlog #9), and the full settings page (backlog #8). This sprint ships only the minimal controls listed in Q10.

## 5. Open questions (recommended default in **bold**)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Which domain and From address will send nudges? | **Dry-run until you choose one**; for a first real send, Resend's `onboarding@resend.dev` to your own account address |
| Q2 | Email opt-in default | **Off** for new and existing users; ask with a toggle when they start tracking a product |
| Q3 | Require a verified email before sending? | **No for v1** (explicit opt-in + one-click unsubscribe); revisit with backlog #9 |
| Q4 | Daily cap | **1 email per user per local day** |
| Q5 | Default send hour and timezone | **09:00 local**; timezone pre-filled from the browser at opt-in, `UTC` until then |
| Q6 | Snooze options and limit | **7 or 30 days, max 3 per nudge** |
| Q7 | Retry policy | **5 attempts; backoff 1 min, 5 min, 30 min, 2 h; then `FAILED`** |
| Q8 | Send inline from the reconciler when Redis is down? | **Yes** (the claim makes it safe) |
| Q9 | Timezone math | **`Intl`-based helper, no new dependency**, with DST tests; alternative `@date-fns/tz` (small, official) if the helper gets hairy; I'd ask before adding it |
| Q10 | UI scope this sprint | **Minimal:** email-reminder toggle + timezone/hour on the profile page; optional "when did you get it?" date on the first review; Skip and Snooze buttons on dashboard check-ins. Each verified in a browser |
| Q11 | Stage offsets | **Calendar offsets from the anchor**, as in D3 |
| Q12 | Minimum gap after a review | **7 days** |
| Q13 | `GET /api/nudges` returns only due check-ins (behavior change) | **Yes**; the current "all pending, including future" list is misleading |
| Q14 | Fix the Redis URL parsing (password/DB index ignored) while touching the queue | **Yes**, in its own commit |
