#!/usr/bin/env bash
# One-command health check for the Verdict dev environment.
#   bash scripts/doctor.sh
# Checks: Docker, ports 5432/6379, env files, installed dependencies, migrations, and the seed.
# Prints OK / WARN / FAIL / SKIP per check with a suggested fix. Exits 1 if anything FAILED.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else G=; Y=; R=; D=; N=; fi
fails=0; warns=0
ok()   { printf '%s[ OK ]%s %s\n' "$G" "$N" "$1"; }
warn() { warns=$((warns + 1)); printf '%s[WARN]%s %s\n' "$Y" "$N" "$1"; [ -n "${2:-}" ] && printf '       %sfix:%s %s\n' "$D" "$N" "$2"; }
fail() { fails=$((fails + 1)); printf '%s[FAIL]%s %s\n' "$R" "$N" "$1"; [ -n "${2:-}" ] && printf '       %sfix:%s %s\n' "$D" "$N" "$2"; }
skip() { printf '%s[SKIP]%s %s\n' "$D" "$N" "$1"; }
port_open() { node scripts/wait-for-port.js localhost "$1" 2 >/dev/null 2>&1; }

echo "Verdict doctor"
echo

# ── Ports (checked first: they decide how serious a Docker problem is) ─────────────────────────
pg_up=0; redis_up=0
port_open 5432 && pg_up=1
port_open 6379 && redis_up=1

# ── Docker ─────────────────────────────────────────────────────────────────────────────────────
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then
  if [ "$pg_up" -eq 1 ] && [ "$redis_up" -eq 1 ]; then
    warn "Docker CLI not found (but Postgres and Redis are reachable, so something else is providing them)"
  else
    fail "Docker CLI not found" "check the docker-in-docker feature in .devcontainer/devcontainer.json, then rebuild the container"
  fi
elif ! docker info >/dev/null 2>&1; then
  if [ "$pg_up" -eq 1 ] && [ "$redis_up" -eq 1 ]; then
    warn "Docker daemon not reachable (but Postgres and Redis are reachable, so something else is providing them)"
  else
    fail "Docker daemon not reachable" "wait a minute after start, then 'sudo service docker status'; or rebuild the container"
  fi
else
  docker_ok=1
  ok "Docker daemon reachable ($(docker --version 2>/dev/null | sed 's/,.*//'))"
  running=$(docker compose ps --status running --services 2>/dev/null | tr '\n' ' ')
  for svc in postgres redis; do
    case " $running " in
      *" $svc "*) ok "compose service '$svc' is running" ;;
      *) fail "compose service '$svc' is not running" "docker compose up -d postgres redis" ;;
    esac
  done
fi

if [ "$pg_up" -eq 1 ]; then ok "Postgres accepting connections on localhost:5432"
else fail "Postgres not reachable on localhost:5432" "docker compose up -d postgres  (then: node scripts/wait-for-port.js localhost 5432)"; fi
if [ "$redis_up" -eq 1 ]; then ok "Redis accepting connections on localhost:6379"
else fail "Redis not reachable on localhost:6379" "docker compose up -d redis"; fi

# ── Env files ──────────────────────────────────────────────────────────────────────────────────
if [ -f backend/.env ]; then
  if grep -q '^DATABASE_URL=.*@localhost:5432/' backend/.env; then ok "backend/.env present, DATABASE_URL points at localhost:5432"
  else warn "backend/.env present but DATABASE_URL does not point at localhost:5432" "compare with backend/.env.example"; fi
else
  fail "backend/.env missing" "cp backend/.env.example backend/.env"
fi
[ -f frontend/.env ] && ok "frontend/.env present" || warn "frontend/.env missing" "cp frontend/.env.example frontend/.env"

# ── Dependencies ───────────────────────────────────────────────────────────────────────────────
deps_ok=1
for dir in . frontend backend; do
  if [ -d "$dir/node_modules" ]; then ok "node_modules installed in ${dir}"
  else deps_ok=0; fail "node_modules missing in ${dir}" "bash .devcontainer/install-deps.sh"; fi
done
if python3 -c 'import fastapi, uvicorn, sklearn' >/dev/null 2>&1; then ok "ML Python dependencies importable"
else fail "ML Python dependencies not importable (fastapi/uvicorn/scikit-learn)" "python3 -m pip install -r ml/requirements.txt"; fi

# ── Migrations and seed (need Postgres + backend deps) ─────────────────────────────────────────
if [ "$pg_up" -ne 1 ] || [ ! -d backend/node_modules ] || [ ! -f backend/.env ]; then
  skip "migrations: need Postgres, backend dependencies and backend/.env"
  skip "seed: needs Postgres, backend dependencies and backend/.env"
else
  db_json=$(cd backend && node ../scripts/db-status.js 2>&1); db_rc=$?
  field() { printf '%s' "$db_json" | sed -n "s/.*\"$1\":\([a-z0-9]*\).*/\1/p"; }

  mig_out=$(cd backend && npx prisma migrate status 2>&1); mig_rc=$?
  if [ "$mig_rc" -eq 0 ]; then
    ok "migrations: database schema is up to date"
  elif [ "$db_rc" -ne 0 ]; then
    if printf '%s' "$db_json" | grep -qiE "authentication|denied|P1000"; then
      fail "migrations: cannot log in to the database with backend/.env's DATABASE_URL" "check the credentials against docker-compose.yml"
    else
      fail "migrations: cannot read the database ($db_json)" "check that Postgres is healthy: docker compose ps"
    fi
  elif [ "$(field usersTable)" = "true" ] && [ "$(field migrationHistory)" = "false" ]; then
    fail "migrations: schema exists but has no migration history (created with 'prisma db push')" "recreate the DB ('docker compose down -v && docker compose up -d'); to keep data see the README section on db push"
  elif printf '%s' "$mig_out" | grep -qi 'not yet been applied'; then
    fail "migrations: pending migrations" "npm run db:deploy"
  else
    fail "migrations: 'prisma migrate status' failed" "run it by hand: cd backend && npx prisma migrate status"
  fi

  if [ "$db_rc" -ne 0 ]; then
    skip "seed: database is not readable (see migrations above)"
  elif [ "$(field usersTable)" != "true" ]; then
    skip "seed: no schema yet (apply migrations first: npm run db:deploy)"
  elif [ "$(field hasDemoUser)" = "true" ]; then
    ok "seed: demo user alice@example.com present ($(field users) users total)"
  elif [ "$(field users)" = "0" ]; then
    fail "seed: database is empty" "npm run db:seed"
  else
    warn "seed: $(field users) users but alice@example.com is missing (demo login won't work)" "npm run db:seed (only on a database you can reset)"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  [ "$warns" -eq 0 ] && echo "All checks passed. Run: npm run dev" || echo "No failures (${warns} warning(s)). Run: npm run dev"
else
  echo "${fails} check(s) failed. Fix the items above, then re-run: bash scripts/doctor.sh"
  exit 1
fi
