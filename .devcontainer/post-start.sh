#!/usr/bin/env bash
# Runs every time the Codespace starts or resumes from hibernate.
# Lightweight — just ensures services are healthy and env is intact.

set -e

# ── Ensure .env exists (in case volume was reset) ──────────
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  sed -i 's|localhost:5432|postgres:5432|g' backend/.env
  sed -i 's|redis://localhost|redis://redis|g' backend/.env
  sed -i 's|your-super-secret-jwt-key-change-in-production-min-32-chars|verdict-dev-jwt-secret-not-for-production-use|g' backend/.env
  sed -i 's|your-super-secret-refresh-key-change-in-production-min-32-chars|verdict-dev-refresh-secret-not-for-production-use|g' backend/.env
  echo "✅ Recreated backend/.env"
fi

# ── Wait for Postgres ──────────────────────────────────────
echo "⏳ Waiting for Postgres..."
until pg_isready -h postgres -U verdict_user -d verdict_db 2>/dev/null; do
  sleep 2
done

# ── Ensure migrations are applied (safe to run repeatedly) ─
echo "🗄️  Ensuring DB schema is current..."
cd backend && npx prisma migrate deploy --skip-generate 2>/dev/null || true && cd ..

echo "✅ Verdict is ready — run 'npm run dev' to start"
