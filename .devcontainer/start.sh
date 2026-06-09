#!/bin/bash
set -e

# Start database and cache
docker compose up -d

# Create backend .env if missing
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  sed -i 's/your_password/verdict_dev_password/' backend/.env
  echo "Created backend/.env"
fi

# Wait for Postgres to be ready
echo "Waiting for Postgres..."
until docker exec verdict-postgres pg_isready -U verdict_user -d verdict_db > /dev/null 2>&1; do
  sleep 1
done

# Push schema and seed if the users table is empty
cd backend
ROW_COUNT=$(docker exec verdict-postgres psql -U verdict_user -d verdict_db -tAc "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
if [ "$ROW_COUNT" = "0" ]; then
  echo "Seeding database..."
  npx prisma db push --accept-data-loss
  npx prisma db seed
fi
cd ..

echo "✅ Verdict dev environment ready"
