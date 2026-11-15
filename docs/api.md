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

### POST /auth/register
Create a new user account.

**Body:**
```json
{
  "email": "user@example.com",
  "username": "myusername",
  "password": "securepass123",
  "displayName": "Jane Smith"
}
```
**Response:** `{ user, accessToken, refreshToken }`

---

### POST /auth/login
**Body:** `{ email, password }`
**Response:** `{ user, accessToken, refreshToken }`

---

### POST /auth/refresh
Exchange a refresh token for new tokens.
**Body:** `{ refreshToken }`
**Response:** `{ accessToken, refreshToken }`

---

### GET /auth/me *(auth)*
Returns current user with demographics.

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
Get full product details.

---

### POST /products *(auth)*
Add a new product.

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
List all categories with counts.

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
{ "emailNudgesEnabled": false, "emailNudgesConsentAt": null, "timezone": "UTC", "nudgeSendHour": 9, "emailVerified": false, "nudgePromptDismissedAt": null }
```
`nudgePromptDismissedAt` is set when the user declined the post-first-review opt-in prompt (see below).

### PUT /users/me/notification-settings *(auth)*
Any subset of `{ "emailNudgesEnabled": boolean, "timezone": "Europe/Berlin", "nudgeSendHour": 0-23 }`. Turning email on records `emailNudgesConsentAt`; turning it off clears it. `timezone` must be an IANA name (400 otherwise). Changing the time zone or hour moves pending nudges to the new local send time. Unknown fields → 400, including `nudgePromptDismissedAt`: this endpoint never sets or clears a declined prompt, so opting in or out here later leaves it as it is.

### POST /users/me/nudge-prompt/dismiss *(auth)*
The user declined the email opt-in prompt ("No thanks, don't ask again"). Sets `nudgePromptDismissedAt` to now if it is not set yet (a repeat keeps the first time) and changes nothing else. Returns the notification settings. The frontend shows the prompt after the first review of each product only while `emailNudgesEnabled` is false and `nudgePromptDismissedAt` is null.

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
