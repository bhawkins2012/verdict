#!/usr/bin/env bash
# Runs on every Codespace start (postStartCommand). Idempotent.
#
# ALWAYS exits 0, even when something fails: a failing lifecycle step can put the codespace into
# recovery mode, and a running container you can fix from a shell is better. Failures are printed
# in a summary at the end; diagnose with:  bash scripts/doctor.sh
set -uo pipefail
cd "$(dirname "$0")/.."

problems=()
note() { problems+=("$1"); echo "!! $1"; }

# ── Env files (copied from the single localhost template; no editing) ──────────────────────────
[ -f backend/.env ]  || cp backend/.env.example backend/.env   || note "could not create backend/.env"
[ -f frontend/.env ] || cp frontend/.env.example frontend/.env || note "could not create frontend/.env"

# ── Docker (docker-in-docker: the daemon starts asynchronously after the container) ───────────
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then
  note "docker CLI not found. Check the docker-in-docker feature in .devcontainer/devcontainer.json."
else
  waited=0
  while [ "$waited" -lt "${DOCKER_WAIT_SECONDS:-60}" ]; do
    if docker info >/dev/null 2>&1; then docker_ok=1; break; fi
    sleep 2; waited=$((waited + 2))
  done
  [ "$docker_ok" -eq 1 ] || note "Docker daemon is not reachable (waited ${waited}s). Try: sudo service docker status"
fi

if [ "$docker_ok" -eq 1 ]; then
  docker compose up -d postgres redis \
    || note "'docker compose up -d postgres redis' failed. Try it by hand to see the error (image pull? port in use?)."
fi

# ── Wait for the ports (short if Docker is down: nothing is going to start them) ───────────────
pg_wait=90; redis_wait=30
if [ "$docker_ok" -ne 1 ]; then pg_wait=5; redis_wait=5; fi

pg_up=0
if node scripts/wait-for-port.js localhost 5432 "$pg_wait"; then pg_up=1
else note "Postgres is not accepting connections on localhost:5432."; fi
node scripts/wait-for-port.js localhost 6379 "$redis_wait" \
  || note "Redis is not accepting connections on localhost:6379 (nudge scheduling will not work)."

# ── Migrate and seed (only if Postgres is reachable) ───────────────────────────────────────────
if [ "$pg_up" -eq 1 ]; then
  mig_out=$(cd backend && npx prisma migrate deploy 2>&1); mig_rc=$?
  printf '%s\n' "$mig_out"
  if [ "$mig_rc" -ne 0 ]; then
    if printf '%s' "$mig_out" | grep -q 'P3005'; then
      note "'prisma migrate deploy' failed with P3005: this database predates migrations. Easiest: recreate it ('docker compose down -v && docker compose up -d'). To keep the data, see the README section on db push."
    elif printf '%s' "$mig_out" | grep -qE 'P1000|P1001|P1003'; then
      note "'prisma migrate deploy' could not connect or authenticate. Check DATABASE_URL in backend/.env against docker-compose.yml."
    else
      note "'prisma migrate deploy' failed (see the output above)."
    fi
  else
    # Seed only an empty database so restarts never duplicate or overwrite data.
    if status=$(cd backend && node ../scripts/db-status.js 2>&1); then
      users=$(printf '%s' "$status" | sed -n 's/.*"users":\([0-9]*\).*/\1/p')
      if [ "${users:-}" = "0" ]; then
        (cd backend && npx prisma db seed) || note "'prisma db seed' failed."
      fi
    else
      note "Could not read the database after migrating: $status"
    fi
  fi
fi

echo
if [ "${#problems[@]}" -eq 0 ]; then
  echo "Verdict dev environment ready. Run: npm run dev"
else
  echo "Verdict dev environment started WITH PROBLEMS (the codespace itself is fine):"
  for p in "${problems[@]}"; do echo "  - $p"; done
  echo "Run 'bash scripts/doctor.sh' for a full check, fix the cause, then 'bash .devcontainer/start.sh' again."
fi
exit 0
