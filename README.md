# Verdict — Longitudinal Review Platform

> Reviews that evolve. Recommendations that know you.

Verdict captures product and experience reviews over time — initial impression, 1 week, 1 month, 1 year — and uses demographic-aware statistical modeling to surface recommendations based on *how opinions shift*, not just snapshots.

---

## Monorepo Structure

```
verdict/
├── frontend/          # React + TypeScript SPA
├── backend/           # Node.js + Express API
├── ml/                # Python recommendation engine
└── docs/              # Architecture docs
```

## Quick Start

### Prerequisites
- Node.js 20+
- Python 3.11+
- PostgreSQL 15+
- Redis 7+

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/verdict
cd verdict

# Install root tooling
npm install

# Install frontend deps
cd frontend && npm install && cd ..

# Install backend deps
cd backend && npm install && cd ..

# Install ML deps
cd ml && pip install -r requirements.txt && cd ..
```

### 2. Environment Setup

```bash
# Backend
cp backend/.env.example backend/.env
# Edit backend/.env with your DB credentials

# Frontend
cp frontend/.env.example frontend/.env
```

### 3. Database Setup

```bash
cd backend
npx prisma migrate dev --name init
npx prisma db seed
```

### 4. Run Everything

```bash
# From root — runs all services concurrently
npm run dev
```

Or individually:
```bash
npm run dev:frontend   # http://localhost:5173
npm run dev:backend    # http://localhost:3001
npm run dev:ml         # http://localhost:8000
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  React SPA (Vite + TypeScript + Tailwind)               │
└─────────────────┬───────────────────────────────────────┘
                  │ REST API
┌─────────────────▼───────────────────────────────────────┐
│  Express API (Node.js + Prisma ORM)                     │
│  Auth · Reviews · Products · Users · Nudge Queue        │
└──────────┬────────────────────────┬─────────────────────┘
           │                        │
┌──────────▼──────┐      ┌──────────▼──────────────────┐
│  PostgreSQL     │      │  Python ML Service (FastAPI) │
│  + pgvector     │      │  Collaborative Filtering     │
│  Redis (BullMQ) │      │  Drift Scoring · Embeddings  │
└─────────────────┘      └──────────────────────────────┘
```

## Key Features

- **Longitudinal Reviews**: Track opinion drift over time (initial → 1wk → 1mo → 1yr)
- **Drift Score**: Quantifies how much a user's opinion changed
- **Survivorship Curves**: Aggregate satisfaction over time per product
- **Demographic Recommendations**: Collaborative filtering weighted by user profile
- **Review Aggregation**: Import pipeline for Amazon/Google/Yelp reviews
- **Nudge Scheduler**: BullMQ jobs to prompt follow-up reviews at the right time

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Zustand, React Query |
| Backend | Node.js, Express, Prisma ORM, BullMQ, Zod |
| Database | PostgreSQL 15, pgvector extension, Redis |
| ML Service | Python, FastAPI, scikit-learn, pandas, numpy |
| Auth | JWT + refresh tokens |
| Testing | Vitest (FE), Jest (BE), pytest (ML) |

## API Documentation

See `docs/api.md` for full OpenAPI spec.

Run the backend and visit `http://localhost:3001/api/docs` for interactive Swagger UI.
