#!/usr/bin/env bash
# Runs on every Codespace start. Idempotent: safe to run repeatedly.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres redis

[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env ] || cp frontend/.env.example frontend/.env

node scripts/wait-for-port.js localhost 5432 90
node scripts/wait-for-port.js localhost 6379 30

cd backend
npx prisma migrate deploy

# Seed only an empty database so reloads don't duplicate or overwrite data.
USERS=$(docker compose exec -T postgres psql -U verdict_user -d verdict_db -tAc 'SELECT COUNT(*) FROM users' | tr -d '[:space:]')
if [ "$USERS" = "0" ]; then
  npx prisma db seed
fi

echo "Verdict dev environment ready. Run: npm run dev"
