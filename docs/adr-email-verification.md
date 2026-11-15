# ADR: Email verification

**Status:** proposed (Sprint 2, backlog #9)
**Context owner:** product owner decides the open questions in section 4.

## 1. Context

`users.emailVerified` exists but nothing sets it, except the seed (all three demo users are verified). Nudges already refuse real-provider email to unverified addresses (`NUDGE_REQUIRE_VERIFIED_EMAIL=true`, `backend/src/nudges/sender.ts`). So real nudge email is effectively off until users can verify.

What exists today and matters here:

| Area | Today | Consequence |
|---|---|---|
| Register | `POST /api/auth/register` returns **409 "Email or username already taken"**, otherwise **201** with access and refresh tokens (the user is logged in at once). | The 409 reveals whether an email address is registered (account enumeration). An identical response for known and unknown addresses cannot carry tokens, so the register contract has to change (D3). |
| Login | `POST /api/auth/login` returns 401 "Invalid credentials" for both an unknown email and a wrong password, but returns **before** running bcrypt when the email is unknown. | The response is identical, but timing still reveals unknown addresses. |
| Email change | No endpoint. Email is set once at registration. | New endpoint needed (D7). |
| Email sending | `EmailProvider` interface (`backend/src/nudges/providers/`): `console` (dry run, keeps the last 50 messages in memory, the default) and `resend`. Provider config lives in `NUDGE_*` env vars. | Reused (D5). |
| Signed links | Unsubscribe: an HMAC link, GET shows a confirm page, POST acts. Dev routes are gated by a `NODE_ENV` allow-list (`development`, `test`). | The same patterns are reused (D2, D6). |
| Rate limiting | One global `express-rate-limit` (200 per 15 min per IP on `/api`), keyed by `req.ip`, which comes from `TRUST_PROXY`. In-memory store, so the limit is per process. | Reused for per-IP limits (D4). |

## 2. Decisions

### D1. Token

- **Format.** The link carries a **selector** (the token row's id, a cuid) and a **verifier**: 32 bytes from `crypto.randomBytes`, base64url-encoded (43 characters).
- **Storage.** The database stores only `sha256(verifier)`, never the verifier. The selector is not secret.
- **Check.**
  1. Look up the row by selector.
  2. Compare `sha256(verifier)` with the stored hash using `crypto.timingSafeEqual`, with an explicit length check first.
  3. Then check: not used, not superseded, not expired, and `token.email === user.email` (D7).
- **Expiry and single use.** A token expires 24 h after it is issued. Consuming it is one conditional `UPDATE ... WHERE id = $1 AND "usedAt" IS NULL AND "supersededAt" IS NULL AND "expiresAt" > now()`, so of two concurrent clicks exactly one succeeds. Setting `users.emailVerified = true` (and `emailVerifiedAt`) happens in the same transaction.
- **Supersession.** Issuing a new token marks all of that user's unused tokens `supersededAt = now()` in the same transaction as the insert. Only the newest link works. Verifying also supersedes any other open tokens.
- **Invalid links.** Every failure (unknown selector, wrong verifier, used, superseded, expired, email changed) returns the **same** 400 "This link is invalid or has expired". The page then offers to send a new link if the user is logged in. Logs record the specific reason, for support.

*Why SHA-256 and not bcrypt or argon2:* the verifier has 256 bits of entropy, so a slow hash adds nothing against brute force. A fast hash is enough to make a database leak useless. *Why a selector:* looking up by hash alone would compare inside a B-tree index, which is not constant-time. The selector moves the secret comparison into `timingSafeEqual`.

*Alternatives considered:*
- An HMAC-signed stateless link, like unsubscribe. It cannot be single-use or superseded without server state, and revoking it means rotating a secret.
- A JWT. Same problem, plus a larger link.
- A 6-digit code. It needs strict attempt limits and is worse for click-through.

### D2. Link behaviour: confirm page, then POST

- **The link.** The email links to the **frontend** route `/verify-email#id=<selector>&t=<verifier>`.
  - The token is in the URL **fragment**, which browsers never send to servers, so it does not reach access logs, the `Referer` header or proxies.
  - The page shows "Confirm your email address [Confirm]". Only the button POSTs `{ id, token }` to `POST /api/auth/verify-email`.
  - Mail scanners that prefetch GET links (and do not run JavaScript to click buttons) cannot consume the token.
- **No login required.** The link is often opened on another device, such as a phone. The token is the credential.
- **Outcomes.** Success shows "Email verified". If the user is logged in in that browser, the banner disappears; the page refetches `/auth/me`. Failure shows the generic message, plus "Send a new link" if logged in, or "Log in to request a new link" if not.

*Same pattern as unsubscribe* (a GET that never acts, a POST that does), with one difference. Unsubscribe is a server-rendered page under `/api/nudges/unsubscribe` because it must work with no app context. Verification is a step inside the app, so it is a SPA route that can update the logged-in session's state.

*Alternatives considered:*
- A GET link that verifies directly: scanners would consume it.
- A server-rendered page under `/api` like unsubscribe: fine, but it cannot refresh the app's state; it would be the fallback if the SPA approach failed.

### D3. Register without enumeration

- **New contract.** `POST /api/auth/register` returns **202 `{ "message": "Check your email to verify your address." }`** for both a new address and an already-registered one. Validation errors stay 400. A taken **username** stays 409 (usernames are public profile handles, not secret).
- **Order of checks matters.** The username is checked first and returns 409 regardless of the email. Otherwise a taken username sent with a known address could give a different answer than with an unknown one.
- **New address.** Create the user (unverified), issue a token and send the verification email.
- **Known address.** Create nothing and change nothing. Run the same bcrypt hash so timing does not differ. Send the address's owner a short "Someone tried to create a Verdict account with this address. If it was you, log in or reset your password" email (the reset flow does not exist yet; the copy says "log in"). This is limited to 1 such email per address per hour.
- **Logging in after register.** The frontend calls `POST /api/auth/login` with the same credentials right after the 202.
  - A new user is logged in with no extra step (the soft gate, D8).
  - Someone registering a known address with a different password gets the generic 401 from login, and the page says "Check your email". That reveals nothing: a wrong password for an unknown address looks the same.
- **Login timing.** Login runs bcrypt against a fixed dummy hash when the email is unknown, so its timing no longer reveals unknown addresses.
- **Email sends happen after the response** (D5) in both register paths, so the provider's latency does not reveal which path ran.

*Alternatives considered:*
- Keep the 409. It is simple, but it is the enumeration the requirement rules out.
- Return 201 with tokens for new accounts and a fake success for known ones. The response shapes differ, so it still enumerates.
- Verify-before-login (a hard gate). It contradicts D8 and loses users who mistype their address.

### D4. Abuse controls

| Control | Limit (defaults, env-tunable) | Where enforced | Why |
|---|---|---|---|
| Resend cooldown, per user | 60 s since the last token issued | DB: newest `email_verification_tokens.createdAt` for the user | Holds across processes and restarts. The in-memory limiter does not. |
| Resend cap, per user | 5 tokens per rolling hour | DB: count of the user's tokens in the last hour | Same. Also caps register-triggered tokens. |
| Per-IP limit on `register`, `resend`, `verify-email` and `email` change | 10 per 15 min per IP for each route group (`VERIFY_RATE_LIMIT_MAX`) | `express-rate-limit`, keyed by `req.ip` (so `TRUST_PROXY` decides the client IP), mounted on those routes in addition to the global `/api` limiter | Reuses the existing mechanism and the trust-proxy decision. It is in-memory and per process, as the global limiter already is; documented. |
| "Someone tried to register" notice | 1 per address per hour | DB: a timestamp on the user (`registerNoticeSentAt`) | Prevents using register to spam a known address. |

- **Responses.** Limits return **429** with `Retry-After`. The 429 for the per-user cooldown is only on the authenticated resend, which reveals nothing about other accounts. On **register**, the per-IP 429 is the only rate response, and it does not depend on whether the address exists. The per-address notice limit just skips the email silently, so the response stays the same 202.
- **No response reveals whether an address is registered.** That covers register (D3), login (identical 401, constant work), resend (authenticated: it acts on the caller's own address only, and the body takes no address) and email change (D7, open question Q3).

*Alternatives considered:*
- A Redis-backed rate-limit store. It is cross-process, but adds a Redis dependency to auth, which today works with Redis down (Redis is only the nudge queue). The DB-backed per-user checks already cover the multi-instance case for the limits that matter.
- CAPTCHA on register: deferred until abuse is observed.

### D5. Delivery: inline, best-effort, after the response; the resend button is the retry

- **Sending.** Verification emails go through the existing `EmailProvider`: dry-run by default, Resend when configured. The message is built by a new `renderVerificationEmail` and carries `Idempotency-Key: verify/<tokenId>`.
- **When.** Each email is sent **once, after the HTTP response, after the transaction that created the token commits**. A failure is logged with the token id and the provider error, and is not retried automatically.
- **Recommendation: this simple option, not the nudge retry engine.**
  - **It cannot lose a user.** The soft gate (D8) means a failed send never locks anyone out: they are logged in, see the banner, and can press "Resend" once the provider recovers. The token row exists either way.
  - **The user is present.** The nudge engine exists because nudges are scheduled weeks ahead for users who are not online. Verification happens while the user is in the app, so a human-driven retry is enough. Background retries could deliver a stale email minutes later, after the user has already requested a newer one, and that stale link would be superseded and fail.
  - **Less to get right.** Reusing the nudge engine would mean a new job type, claim states and reconciler paths for a message with a 24 h life.
- **Health signal.** The banner reads "We sent a link to a\*\*\*@example.com. Didn't get it? Resend". It does not claim delivery. `GET /api/auth/me` exposes `emailVerificationSentAt` (the newest token's `createdAt`) so the banner can say when.

*Alternatives considered:*
- Queue on BullMQ with retries. It gets automatic recovery from a short provider outage, but adds a Redis dependency to registration and the stale-link race above.
- Send inside the request before responding: registration latency would include the provider's, and the timing would differ between the D3 paths.

### D6. Dev experience

- **Dry run.** With the `console` provider the email is logged (as nudge emails are), including the full verification link. The dry-run outbox keeps it in memory.
- **`GET /api/auth/dev/verification-link`** (authenticated) returns your own newest verification link from the dry-run outbox, or 404 if there is none. It uses the **same `NODE_ENV` allow-list as the nudge dev routes** (`development` or `test`; 404 for anything else, including unset or `staging`). The shared `devOnly` guard moves to `backend/src/middleware/devOnly.ts` so both routers use one definition.
- **Why read the outbox, not the database:** the database stores only hashes (D1). The plaintext link exists only in the message that was "sent".

### D7. Email change

- **Endpoint.** New `PUT /api/users/me/email { "email", "currentPassword" }`. It is authenticated, and the current password is required: a stolen session must not be able to move the account. Per-IP limited (D4).
- **In one transaction:**
  - set `email`;
  - reset `emailVerified = false` and `emailVerifiedAt = null`;
  - supersede all outstanding tokens;
  - issue a token for the new address.
- **After commit:**
  - Send the verification email to the **new** address.
  - Send a notice to the **old** address: "The email address on your Verdict account was changed to n\*\*\*@example.com. If you didn't do this, contact support." The new address is masked. The notice has no link to undo the change; that needs an account-recovery flow, which is out of scope and listed as a follow-up.
- **Tokens bind to an address.** A token stores the address it was issued for. Confirming it requires `token.email === user.email`, so a link sent to an old address can never verify a new one, even if it was somehow not superseded.
- **Nudges** need no change: until the new address is verified, real-provider nudges go in-app only (existing gate). Email consent (`emailNudgesEnabled`) is kept (open question Q4).
- **Same address.** Submitting the current address is a no-op (200, nothing sent).
- **Already-used address.** The unique constraint on `users.email` makes the change fail. See Q3 for what the response says.

### D8. Gating: soft

- **Before verification, everything works:** login, reviews, the whole app.
- **The banner.** Unverified users see it on every page: "Please verify a\*\*\*@example.com. [Resend email]". It shows status, cooldown and error. It is gone once verified.
- **Only real-provider nudge emails require verification.** That is the existing `NUDGE_REQUIRE_VERIFIED_EMAIL` check, unchanged. Dry-run sends and in-app check-ins never do.
- **Seed users stay verified.** The seed already sets `emailVerified: true`; it also sets `emailVerifiedAt`.
- **Existing non-seed users stay unverified** (no backfill). They see the banner and can verify; nothing else changes for them.

### D9. Schema and migration plan

The migration has its own commit and is applied with `prisma migrate deploy` only.

```prisma
model User {
  // existing emailVerified Boolean stays the gate
  emailVerifiedAt      DateTime?
  registerNoticeSentAt DateTime?   // D4: "someone tried to register" notice limit
  verificationTokens   EmailVerificationToken[]
}

model EmailVerificationToken {
  id           String    @id @default(cuid())   // the selector (public)
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  email        String                            // the address this token verifies (D7)
  tokenHash    String                            // hex sha256(verifier); never the verifier
  createdAt    DateTime  @default(now())
  expiresAt    DateTime
  usedAt       DateTime?
  supersededAt DateTime?

  @@index([userId, createdAt])
  @@map("email_verification_tokens")
}
```

- **Additive only:** a new table, two nullable columns, no backfill. Existing data is untouched, and the seed sets `emailVerifiedAt` for its verified users.
- **Retention.** Token rows older than 30 days are deleted by a small cleanup query on the reconciler's existing hourly sweep tick, so no new scheduler is needed.
- **Verification before merge:** `migrate deploy` on the seeded dev database and on an empty database, and `prisma migrate diff` empty (CI checks this too).

### D10. Email content

- **Format.** Plain text plus minimal HTML (a heading, one sentence, one link-button, a footer).
  - No images, tracking pixels or click-tracking redirects.
  - Resend's open and click tracking is not enabled, since the provider sends exactly what we render.
- **Verification email:**
  - Subject: "Confirm your email for Verdict".
  - Body: "Confirm this address to get review check-ins by email: <link>. The link works once and expires in 24 hours. If you didn't create a Verdict account, ignore this email."
- **Notices:** the "someone tried to register" notice (D3) and the "email changed" notice (D7), in the same style.
- **Footer:** "Verdict · {NUDGE_POSTAL_ADDRESS}". It shows the same placeholder as nudge emails until configured. There is no unsubscribe link: these are transactional, not marketing.
- **Sender:** the From address is `NUDGE_FROM_EMAIL` for now (Q5).
- **Escaping:** the same HTML-escaping helper as nudge emails; no user-supplied text in subject lines.

### D11. Smoke test against a real provider (Step 4)

`npm run email:smoke -- <address>` (backend):
- sends one verification-style email through the configured provider;
- prints the provider's response (message id, or the error with status);
- **refuses to run with the dry-run provider** (exit code 1 and a message).

It uses no database and creates no token, and the link in it points to a page that says "This was a test email". **Real delivery stays unverified until you run it with a real Resend key.**

## 3. Testing plan (Step 3)

All on real Postgres, with the provider mocked:
- **Token rules:** expiry (23h59m OK, 24h01m invalid), single use (including two concurrent confirms: exactly one succeeds), a tampered verifier or selector, a token superseded by a newer one, and a token issued for an old address after an email change.
- **Rate limits:** per-user cooldown and hourly cap through the DB, per-IP 429 (small env limits in tests, as `RATE_LIMIT_MAX` already allows), and `Retry-After` present.
- **No enumeration:** register with a known vs an unknown address gives byte-identical status and body; a taken username gives 409 regardless of the email; login for an unknown email vs a wrong password gives identical responses (and bcrypt runs on both paths, asserted with a spy).
- **Email change:** resets verification, supersedes tokens, sends a link to the new address and a notice to the old one, and requires the current password.
- **The nudge gate:** a real provider and an unverified user get in-app only; after verifying, the email is sent.
- **Dev route:** 404 outside the allow-list.
- **Mutation-checks:** every rule above, with any test that could not be made to fail reported.

## 4. Open questions (recommended default in **bold**)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Register no longer returns tokens (202 + client-side login, D3). OK to change the API contract? Everything in this repo is updated; there are no external clients. | **Yes** |
| Q2 | Limits: resend cooldown, hourly cap, per-IP limit | **60 s; 5 per hour per user; 10 per 15 min per IP per route group** |
| Q3 | Email change to an address that already belongs to another account. A plain 409 reveals that the address is registered, but only to someone logged in who knows the account password, and it is rate-limited. The alternative is a "pending email" flow: always answer 200 "check the new address", and only switch when the link is confirmed (if the address is taken, the new address gets a "someone tried to use this address" notice instead). | **409 now** (narrow exposure, simple, matches the requested "change resets verification" behaviour); the pending-email flow can go in backlog #8 |
| Q4 | Keep email-reminder consent across an email change? | **Keep** (consent is to Verdict emailing *the account*; nudges stay in-app until the new address is verified) |
| Q5 | From address and env var names. Verification reuses `NUDGE_EMAIL_PROVIDER` / `NUDGE_FROM_EMAIL` / `NUDGE_POSTAL_ADDRESS` / `RESEND_API_KEY`. | **Reuse as-is this sprint**; renaming to `EMAIL_*` with fallbacks is a separate small change |
| Q6 | Lower-case and trim email addresses (today `Alice@x` and `alice@x` can be two accounts)? Changing it touches login lookups and could collide with existing mixed-case rows. | **Defer** to the backlog with a collision check; this sprint does not change normalisation |
| Q7 | Token lifetime | **24 h** (as specified) |
| Q8 | Re-verification after a password change, or periodic re-verification? | **No** |

## 5. Out of scope

- Password reset.
- Account recovery or undo for a changed email.
- Normalising email case (Q6).
- CAPTCHA.
- An unauthenticated "resend by address" endpoint. Not needed with the soft gate, since users can always log in, and it would be both an enumeration and a spam vector.
- The full settings page (backlog #8). The email-change form goes on the existing profile page.
