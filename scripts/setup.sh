#!/usr/bin/env bash
# Verdict — one-shot dev setup

set -e
echo "🏗️  Setting up Verdict..."

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js 20+ required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3.11+ required"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "⚠️  Docker not found — start Postgres/Redis manually"; }

# Install root deps
echo "📦 Installing root dependencies..."
npm install

# Install frontend deps
echo "📦 Installing frontend dependencies..."
cd frontend && npm install && cd ..

# Install backend deps
echo "📦 Installing backend dependencies..."
cd backend && npm install && cd ..

# Install ML deps
echo "🐍 Installing Python dependencies..."
cd ml
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m textblob.download_corpora 2>/dev/null || true
deactivate
cd ..

# Copy env files
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "📝 Created backend/.env from .env.example (dev defaults, localhost)"
fi

if [ ! -f frontend/.env ]; then
  cp frontend/.env.example frontend/.env
fi

# Start DB + Redis via Docker
if command -v docker >/dev/null 2>&1; then
  echo "🐳 Starting Postgres and Redis..."
  docker compose up -d
  echo "⏳ Waiting for Postgres to be ready..."
  node scripts/wait-for-port.js localhost 5432 90
fi

# Run migrations & seed
echo "🗄️  Running database migrations..."
cd backend && npx prisma migrate deploy && cd ..

echo "🌱 Seeding database..."
cd backend && npx prisma db seed && cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "Run 'npm run dev' to start all services:"
echo "  Frontend → http://localhost:5173"
echo "  Backend  → http://localhost:3001"
echo "  ML       → http://localhost:8000"
echo "  Swagger  → http://localhost:3001/api/docs"
echo "  Prisma   → run 'npm run db:studio'"
echo ""
echo "Demo login: alice@example.com / password123"
