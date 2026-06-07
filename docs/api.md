# Verdict API Documentation

Base URL: `http://localhost:3001/api`

Interactive docs: `http://localhost:3001/api/docs` (Swagger UI)

---

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
  "wouldRecommend": true
}
```

**Stages:** `INITIAL | ONE_WEEK | ONE_MONTH | THREE_MONTHS | SIX_MONTHS | ONE_YEAR | TWO_YEARS | CUSTOM`

---

### GET /reviews/threads *(auth)*
Get all review threads for the current user (with latest review and next nudge).

---

### GET /reviews/thread/:productId *(auth)*
Get full thread (all reviews + nudges) for a specific product.

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

## Nudges

### GET /nudges *(auth)*
Get pending check-in nudges for the current user.

---

### POST /nudges/:id/skip *(auth)*
Dismiss a nudge.

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
