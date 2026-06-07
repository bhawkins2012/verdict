#!/usr/bin/env bash
# Runs ONCE when the Codespace container is first created.
# Installs all dependencies, sets up env files, migrates and seeds the DB.

set -e
echo "🏗️  Verdict — first-time setup..."

# ── Node deps ──────────────────────────────────────────────
echo "📦 Installing Node dependencies..."
npm install
cd frontend && npm install && cd ..
cd backend && npm install && cd ..

# ── Python deps ────────────────────────────────────────────
echo "🐍 Installing Python dependencies..."
cd ml
python3 -m venv .venv
source .venv/bin/activate
pip install --quiet -r requirements.txt
python3 -m textblob.download_corpora 2>/dev/null || true
deactivate
cd ..

# ── Env files ──────────────────────────────────────────────
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  # Patch DATABASE_URL and REDIS_URL to use Docker service hostnames
  sed -i 's|localhost:5432|postgres:5432|g' backend/.env
  sed -i 's|redis://localhost|redis://redis|g' backend/.env
  # Set dev JWT secrets (safe for local dev only)
  sed -i 's|your-super-secret-jwt-key-change-in-production-min-32-chars|verdict-dev-jwt-secret-not-for-production-use|g' backend/.env
  sed -i 's|your-super-secret-refresh-key-change-in-production-min-32-chars|verdict-dev-refresh-secret-not-for-production-use|g' backend/.env
  echo "✅ Created backend/.env with Codespaces hostnames"
fi

if [ ! -f frontend/.env ]; then
  cp frontend/.env.example frontend/.env
  echo "✅ Created frontend/.env"
fi

# ── Wait for Postgres ──────────────────────────────────────
echo "⏳ Waiting for Postgres to be ready..."
until pg_isready -h postgres -U verdict_user -d verdict_db 2>/dev/null; do
  sleep 2
done
echo "✅ Postgres is ready"

# ── Migrations & seed ──────────────────────────────────────
echo "🗄️  Running Prisma migrations..."
cd backend
npx prisma migrate dev --name init --skip-generate 2>/dev/null || \
  npx prisma migrate deploy
npx prisma generate

echo "🌱 Seeding database..."
npx prisma db seed

cd ..

echo ""
echo "✅ First-time setup complete!"
echo ""
echo "Run 'npm run dev' to start all three services."
echo "Demo login: alice@example.com / password123"
