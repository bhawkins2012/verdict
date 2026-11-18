# Verdict API Documentation

Base URL: `http://localhost:3001/api`

Interactive docs: `http://localhost:3001/api/docs` (Swagger UI)

---

## Config

### GET /config *(no auth)*
Stage order, labels and the nudge cadence: the single source the frontend derives its stage lists, next-stage prompt and email consent copy from. `Cache-Control: public, max-age=300`.

```json
{
  "stages": [{ "stage": "INITIAL", "label": "first impression" }, { "stage": "ONE_WEEK", "label": "1 week" }, "…", { "stage": "CUSTOM", "label": "custom" }],
  "nudgeCadence": [
    { "stage": "TWO_WEEKS", "label": "2 weeks", "offset": { "days": 14 } },
    { "stage": "THREE_MONTHS", "label": "3 months", "offset": { "months": 3 } },
    { "stage": "ONE_YEAR", "label": "1 year", "offset": { "months": 12 } },
    { "stage": "TWO_YEARS", "label": "2 years", "offset": { "months": 24 } }
  ],
  "consentCopy": "Email me check-ins at 2 weeks, 3 months, 1 year, and 2 years."
}
```

Offsets are calendar offsets from the thread's purchase date (else its first review); month offsets clamp the day (Jan 31 + 3 months = Apr 30).

## Authentication

All protected routes require a Bearer token:
```
Authorization: Bearer <accessToken>
```

Email addresses are trimmed and lower-cased everywhere (register, login, email change). Design: `docs/adr-email-verification.md`.

### POST /auth/register
Create an account. **Does not sign in.**

**Body:** `{ "email": "user@example.com", "username": "myusername", "password": "securepass123", "displayName": "Jane Smith" }`

**Response:** `202 { "message": "Check your email, then sign in." }`, the same for a new address and an already-registered one (no account enumeration). A new address gets a verification email; a registered one gets a "someone tried to sign up" email instead (each at most once per address per hour). Then sign in with `POST /auth/login` (works before verifying).
- `400` invalid body; `409 { "error": "Username already taken" }` (checked before the email, so it never depends on it); `429` per-IP limit.

---

### POST /auth/login
**Body:** `{ email, password }`
**Response:** `{ user, accessToken, refreshToken }`. `401 "Invalid credentials"` for an unknown address and a wrong password alike (same work on both).

---

### POST /auth/refresh
Exchange a refresh token for new tokens.
**Body:** `{ refreshToken }`
**Response:** `{ accessToken, refreshToken }`

---

### GET /auth/me *(auth)*
Current user with demographics, plus `emailVerified`, `emailVerifiedAt` and `emailVerificationSentAt` (when the newest link for the current address was issued, or null).

---

### POST /auth/verify-email *(no auth)*
**Body:** `{ "id": "<selector>", "token": "<verifier>" }`, taken from the link `/verify-email#id=…&t=…` by the confirm page (the page POSTs only when the user presses Confirm).
**Response:** `200 { "verified": true }`. Every failure (unknown, wrong, used, superseded, expired, or issued for a previous address) is the same `400 { "error": "This link is invalid or has expired." }`. `429` per-IP limit.

---

### POST /auth/verification/resend *(auth)*
A new link for **your own** address (the body takes no address). Supersedes earlier links.
**Response:** `202 { "sentTo": "j***@example.com", "sentAt": "…" }`, or `200 { "alreadyVerified": true }`.
`429 { "error", "retryAfterSeconds" }` with `Retry-After`: within 60 s of the last link; 5 links in the last hour; a link already went to this address in the last hour (checked before issuing, so the current link stays valid); or the per-IP limit.

---

### GET /auth/dev/verification-link *(auth, development only)*
Your newest verification link from the dry-run outbox: `{ "link", "sentAt" }`, or 404. Only when `NODE_ENV` is `development` or `test` (404 otherwise).

---

### PUT /users/me/email *(auth)*
**Body:** `{ "email": "new@example.com", "currentPassword": "…" }`
**Response:** `200 { "email", "emailVerified": false, "changed": true }`: the address is changed and unverified, earlier links stop working, a link goes to the new address and a notice (new address masked) to the old one. Email-reminder consent is kept; nudges stay in-app until the new address is verified. Same address: `200 { …, "changed": false }`, nothing sent.
`400` invalid body; `403` wrong current password; `409` address already in use; `429` (with `Retry-After`) after 5 attempts per hour (right or wrong password), when a link went to that address in the last hour, or the per-IP limit.

---

## Products

### GET /products
Search and browse products.

**Query params:**
- `q` — search query
- `category` — filter by category
- `brand` — filter by brand
- `page` (default: 1)
- `limit` (default: 20)

**Response:**
```json
{
  "products": [...],
  "pagination": { "page": 1, "limit": 20, "total": 45, "pages": 3 }
}
```

---

### GET /products/:id
Get full product details. Since Phase A it also returns `levers`: the five published levers of the product's category (empty if the category has none), each with this product's value and source, and the category typical value (median) for measurements.

```json
{
  "id": "…", "name": "Breeze City Compact", "category": "strollers", "categoryId": "…",
  "levers": [
    {
      "lever": { "id": "…", "name": "Fold size", "type": "MEASUREMENT", "inputFormat": "DIMENSIONS", "unit": "cu ft",
                 "explanation": "…", "allowedValues": [], "position": 1 },
      "value": { "unknown": false, "number": 1.86, "unit": "cu ft", "text": null, "bool": true, "list": [],
                 "dimensions": { "lengthIn": 21, "widthIn": 17, "heightIn": 9 }, "detail": null,
                 "source": { "type": "ADMIN_ENTERED", "url": null, "label": "Sample data" },
                 "isSample": true, "recordedAt": "…" },
      "typical": 2.92
    }
  ]
}
```
`value` is `null` when nothing is recorded; `unknown: true` is an explicit unknown. For a `DIMENSIONS` lever, `number` is the folded volume computed from the dimensions and `bool` is one-hand fold.

---

### POST /products *(auth)*
Add a new product. `category` must be an existing category slug (case-insensitive); an unknown one is **400** `Unknown category "x". Valid categories: …` with `validCategories: [...]`. Only admins create categories. Fields not listed below are ignored.

**Body:**
```json
{
  "name": "Breville Barista Express",
  "brand": "Breville",
  "category": "kitchen",
  "subcategory": "espresso",
  "description": "...",
  "priceTier": "PREMIUM",
  "amazonAsin": "B08XYZ1234"
}
```

---

### GET /products/categories/list
Categories to browse, with product counts: only categories with published levers (`[{ "name": "<slug>", "count": 4 }]`). Kept for older clients; use `GET /categories`.

---

## Categories (public)

Design: `docs/adr-levers.md`. Levers in these responses are always the five approved (published) levers; candidates and retired levers never appear.

### GET /categories
Categories with published levers: `[{ "slug": "strollers", "name": "Strollers", "productCount": 4 }]`. Categories without published levers are hidden from browse.

### GET /categories/search?q=
Categories whose name, slug or search terms match `q` (at least 2 characters; a category term inside a longer query matches on whole words). Includes categories still being prepared: `[{ "slug": "car-seats", "name": "Car seats", "published": false }]`; the UI says those are being prepared and does not link them.

### GET /categories/:slug
The category page: `{ category, levers, products, totalInCategory, sort }`. 404 for an unknown category or one without published levers.

- `levers[]`: the five levers in order, each with `options` for building filters: `{ min, max }` for measurements, `{ values }` (known items) for compatibility lists, `null` otherwise.
- `products[]` (at most 100, sorted by name until Best Fit ships): `{ id, name, brand, imageUrl, avgRatingLongterm, totalReviewCount, values: { <leverId>: value } }`.
- **Filters** (query string, qs nested syntax), combined with AND; a product with an unknown or missing value never matches an active filter:

| Lever type | Parameters |
|---|---|
| Measurement | `lever[<id>][min]`, `lever[<id>][max]` (for fold size: the computed volume); a dimensions lever also takes `lever[<id>][is]=yes|no` (one-hand fold) |
| Category | `lever[<id>][in]=Rubber,Foam-filled` (allowed values, case-insensitive) |
| Compatibility list | `lever[<id>][has]=<item>` |
| Yes / no | `lever[<id>][is]=yes|no` |

An unknown lever id, a parameter that does not apply to the lever's type or a bad value is **400**.

---

## Admin *(auth + admin)*

Every route under `/admin` answers 401 without a token and 403 unless the user's role (read from the database on each request) is `ADMIN`. Roles are granted only with `npm run admin:grant -- <email>` (backend), or the seeded `admin@example.com` in development and test. Design: `docs/adr-levers.md`.

| Method and path | Purpose |
|---|---|
| `GET /admin/config` | `{ mode: "dry_run" \| "live", model, dailyLimit, maxTokens }` |
| `GET /admin/categories` | All categories with approved/candidate/product counts |
| `POST /admin/categories` | `{ name, slug?, searchTerms? }` → 201; slug derived from the name if omitted; 409 if taken |
| `GET /admin/categories/:id` | Levers (all statuses, with approval/edit records, value counts and the matching survey ranking), last 10 runs, newest survey (with unmatched rows), products |
| `POST /admin/categories/:id/runs` | `{ notes? }` (≤ 1000 chars) → **202** `{ runId, mode }`; the run continues after the response. **429** `{ error, retryAt }` over the daily live-run limit |
| `GET /admin/runs/:id` | Run status (`RUNNING` / `SUCCEEDED` / `FAILED` with `error`), model, tokens, `costUsd`, candidates stored. Runs older than 10 minutes still `RUNNING` are failed as `timeout` first |
| `POST /admin/categories/:id/levers` | Add a lever by hand: `{ name, type, inputFormat?, unit?, explanation, relatedNeeds?, allowedValues? }` → 201 candidate |
| `PATCH /admin/levers/:id` | Edit name, type, inputFormat, unit, explanation, relatedNeeds, allowedValues. Type, unit and input format are locked once the lever has values (409) |
| `POST /admin/levers/:id/retire` | Retire a candidate; 409 for a published lever (publish a set without it instead) |
| `POST /admin/categories/:id/publish` | `{ leverIds: [5 ids in order] }`: approves and publishes exactly these five, retires the previous set, in one transaction. 400 unless exactly five distinct, non-retired levers of this category, with ≥ 2 allowed values for category levers |
| `POST /admin/categories/:id/survey?filename=` | Body: CSV text (`Content-Type: text/csv`, ≤ 1 MB) with columns `lever, rank, respondents` → 201. All or nothing: 400 `{ error, rows: [{ row, error }] }` |
| `GET /admin/products/:id/levers` | The product's published levers with current values, sources and who recorded them |
| `PUT /admin/products/:productId/levers/:leverId` | Set one value (below) |
| `POST /admin/categories/:id/lever-values/import[?dryRun=true]` | Body: CSV text. All or nothing; `dryRun=true` validates only. → `{ valid, rows, imported }` or 400 with `rows` |

**Value body** (`PUT /admin/products/:productId/levers/:leverId`): `source` is required, with no default.

```json
{ "number": 14.5, "source": { "type": "URL", "url": "https://maker.example/spec" }, "sourceLabel": "Spec page", "detail": "…" }
```

By lever type: measurement `number` (+ optional `unit`, which must equal the lever's); dimensions `dimensions: { lengthIn, widthIn, heightIn }` and `oneHandFold` (the volume is computed, never sent); category `text` (an allowed value); compatibility list `list: [...]`; yes/no `bool`; or `unknown: true` with no value. `source` is `{ "type": "URL", "url": "https://…" }` (http or https only) or `{ "type": "ADMIN_ENTERED" }`.

**Lever value CSV** columns: `product_id, lever, value, source` (required), `unit, unknown, detail, source_label, one_hand_fold` (optional). `lever` is the lever name; `source` is a URL or `entered by admin`; lists use `|`; fold size is `L x W x H` in inches; `unknown` and `one_hand_fold` take yes/no.

---

## Reviews

### POST /reviews *(auth)*
Submit a review (creates thread if first review for this product).

**Body:**
```json
{
  "productId": "clxyz...",
  "stage": "INITIAL",
  "scoreOverall": 8,
  "scoreValue": 7,
  "scoreQuality": 9,
  "scoreLongevity": null,
  "scoreExpectations": 8,
  "bodyText": "First impressions are very positive...",
  "pros": ["Great build quality", "Easy setup"],
  "cons": ["Steep learning curve"],
  "wouldStillBuy": true,
  "wouldRecommend": true,
  "purchasedAt": "2026-10-01"
}
```

**Stages:** `INITIAL | ONE_WEEK | TWO_WEEKS | ONE_MONTH | THREE_MONTHS | SIX_MONTHS | ONE_YEAR | TWO_YEARS | CUSTOM` (chronological; `GET /config` returns the same list with labels). Only `TWO_WEEKS`, `THREE_MONTHS`, `ONE_YEAR` and `TWO_YEARS` are nudged; the others stay valid (existing reviews use them and this endpoint accepts them).

- `purchasedAt` (optional, `YYYY-MM-DD`): when the user got the product; nudge due dates are anchored on it (else on the thread's first review). Accepted on any review (a thread can start at a later stage) and updates the thread; the UI offers it on the first review only. Future dates are rejected with 400 (judged against the most advanced time zone, UTC+14, so nobody's "today" is refused). There is no lower bound: a very old date makes all stages overdue, and the overdue collapse then asks for the single most relevant one. Stored as UTC midnight, so for users west of UTC a check-in can appear in-app a few hours before their local date; the email still goes at their local send hour.
- In the same transaction as the review: the nudge for this stage becomes `COMPLETED`, earlier nudges are `CANCELLED` (superseded), and the next stage's nudge is planned.
- `409` if this stage was already reviewed for this product.

---

### GET /reviews/threads *(auth)*
Get all review threads for the current user (with latest review and next nudge).

---

### GET /reviews/thread/:productId *(auth)*
Get full thread (all reviews + pending nudges) for a specific product. Also returns `nextCheckIn`: `{ "stage": "TWO_WEEKS", "dueAt": "…" }` or `null`, the stage the nudge planner targets next (it follows skips and the overdue collapse; the thread page's next-review button uses it).

---

### PATCH /reviews/:id *(auth)*
Edit a review. Only allowed within 24 hours of creation.

**Editable fields:** `bodyText`, `pros`, `cons`, `wouldStillBuy`, `wouldRecommend`

---

### GET /reviews/product/:productId/stats
Get aggregate stats for a product (public).

**Response:**
```json
{
  "totalReviews": 12,
  "survivorshipCurve": [
    { "stage": "INITIAL", "avgScore": 8.6, "count": 12 },
    { "stage": "ONE_MONTH", "avgScore": 8.1, "count": 9 },
    { "stage": "ONE_YEAR", "avgScore": 7.2, "count": 4 }
  ],
  "wouldRecommendRate": 75,
  "wouldStillBuyRate": 67
}
```

---

## Recommendations

### GET /recommendations *(auth)*
Get personalized product recommendations.

**Query params:**
- `limit` (default: 10)
- `category` — filter to a specific category

**Response:**
```json
{
  "recommendations": [
    {
      "productId": "...",
      "score": 8.3,
      "reason": "Highly rated by users just like you",
      "confidence": 0.83,
      "demographicMatch": 0.74,
      "product": { ... }
    }
  ],
  "userId": "...",
  "isFallback": false
}
```

---

### GET /recommendations/trending
Top-rated products by long-term score (public).

**Query params:** `category`

---

## Users

### GET /users/me/stats *(auth)*
`pendingNudges` counts check-ins that are due now, with exactly the same rule as `GET /nudges`.

**Response:**
```json
{
  "threadCount": 5,
  "reviewCount": 12,
  "pendingNudges": 2,
  "avgDrift": -0.4
}
```

---

### PUT /users/me/demographics *(auth)*
Update demographic profile.

**Body:**
```json
{
  "ageRange": "AGE_25_34",
  "genderIdentity": "woman",
  "region": "US-CA",
  "incomeBracket": "RANGE_75_100K",
  "lifestyleTags": ["tech-early-adopter", "fitness"],
  "householdSize": 2,
  "hasChildren": false
}
```

---

## Notification settings

### GET /users/me/notification-settings *(auth)*
```json
{ "emailNudgesEnabled": false, "emailNudgesConsentAt": null, "timezone": "UTC", "nudgeSendHour": 9, "emailVerified": false, "nudgePromptDismissedAt": null, "emailNudgesFirstEnabledAt": null }
```
`nudgePromptDismissedAt` is set when the user declined the post-first-review opt-in prompt (see below). `emailNudgesFirstEnabledAt` is set the first time email reminders are turned on and never cleared (opting out keeps it).

### PUT /users/me/notification-settings *(auth)*
Any subset of `{ "emailNudgesEnabled": boolean, "timezone": "Europe/Berlin", "nudgeSendHour": 0-23 }`. Turning email on records `emailNudgesConsentAt`; turning it off clears it. `timezone` must be an IANA name (400 otherwise). Changing the time zone or hour moves pending nudges to the new local send time. Unknown fields → 400, including `nudgePromptDismissedAt`: this endpoint never sets or clears a declined prompt, so opting in or out here later leaves it as it is.

### POST /users/me/nudge-prompt/dismiss *(auth)*
The user declined the email opt-in prompt ("No thanks, don't ask again"). Sets `nudgePromptDismissedAt` to now if it is not set yet (a repeat keeps the first time) and changes nothing else. Returns the notification settings. The frontend shows the prompt after the first review of each product only while the user has never opted in (`emailNudgesFirstEnabledAt` is null) and has not declined (`nudgePromptDismissedAt` is null).

---

## Nudges

Check-in reminders; design in `docs/adr-nudges.md`, operations in CLAUDE.md ("Nudges").

### GET /nudges *(auth)*
Check-ins that are **due now** for the current user: due date reached, not snoozed, status `PENDING`, `SENDING`, `SENT` (notified) or `FAILED` (email dead-lettered; still shown in-app). Future nudges are not listed. Each item includes `thread.product`. The nav badge, dashboard banner and `GET /users/me/stats` use the same rule.

### POST /nudges/:id/skip *(auth)*
Never nudge for this stage again (`SKIPPED`) and plan the next stage. Allowed from `PENDING`, `SENT`, `FAILED`; `409` otherwise; `403` if not yours.

### POST /nudges/:id/snooze *(auth)*
Body `{ "days": 7 }` or `{ "days": 30 }`. Hides the check-in until then and emails again afterwards (at most one more email). At most 3 snoozes per nudge (`409` after that); `400` for other values. Returns `{ snoozedUntil, snoozeCount }`.

### GET /nudges/unsubscribe?u=&lt;userId&gt;&t=&lt;token&gt; *(no auth)*
Linked from every nudge email. Shows a confirmation page with a button; **does not unsubscribe by itself** (mail scanners prefetch links). Invalid, tampered or incomplete links → `400` page.

### POST /nudges/unsubscribe?u=&lt;userId&gt;&t=&lt;token&gt; *(no auth)*
Turns email reminders off for that user (`emailNudgesEnabled = false`, consent cleared). Used by the confirmation page and by mail clients' one-click unsubscribe (RFC 8058, body `List-Unsubscribe=One-Click`). The token is an HMAC of the user id and purpose with `UNSUBSCRIBE_SECRET`; it does not expire.

### POST /nudges/:id/send-now *(auth, development only)*
Exists only when `NODE_ENV` is `development` or `test` (`404` otherwise, including staging or unset). Makes one of your nudges due now and runs the real claim-and-send path inline, ignoring the daily cap and send hour. Returns `{ outcome: { kind: "sent" | "in-app" | "completed" | "deferred" | "retry" | "failed" | "not-claimed" | "missing", ... }, nudge }`. With the default dry-run provider nothing is sent.

### GET /nudges/dev/outbox *(auth, development only)*
Development/test only (`404` otherwise). Your messages from the dry-run provider, newest first (subject, text, html, headers).

---

## ML Service (Internal)

Base URL: `http://localhost:8000`

### POST /recommend
Generate recommendations for a user.

### POST /nlp/enrich
Enrich a review text with sentiment score, key topics, and auto-summary.

### POST /drift/analyze
Analyze opinion drift across a series of staged reviews.

---

## Error Format

All errors return:
```json
{ "error": "Human-readable message" }
```

Common status codes:
- `400` — Validation error
- `401` — Authentication required or invalid token
- `403` — Forbidden (not your resource)
- `404` — Not found
- `409` — Conflict (duplicate)
- `500` — Internal server error
