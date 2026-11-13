#!/usr/bin/env bash
# Runs on every Codespace start (postStartCommand). Idempotent.
#
# ALWAYS exits 0, even when something fails or this script itself hits an error: a failing lifecycle
# step can put the codespace into recovery mode, and a running container you can fix from a shell is
# better. The outcome is printed AND written to .devcontainer/last-start.log (gitignored); a hook in
# your shell rc and postAttachCommand show it again in every new terminal, so a failed start cannot go
# unnoticed. Diagnose with:  bash scripts/doctor.sh
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=.devcontainer/last-start.log
RETRY_DELAY="${START_RETRY_DELAY:-5}"   # first backoff in seconds; tripled each retry (5s, 15s)
problems=()
details=()
note()   { problems+=("$1"); echo "!! $1"; }
detail() { details+=("$1"); }           # extra context for the log (last lines of a failing command)
tail_of() { printf '%s\n' "$1" | tail -n "${2:-12}"; }

started=$(date '+%Y-%m-%d %H:%M:%S %Z')
printf 'Verdict start %s  status: RUNNING\n' "$started" > "$LOG" 2>/dev/null || true

summary() {
  local status=OK tmp="$LOG.tmp" p d
  [ "${#problems[@]}" -gt 0 ] && status=PROBLEMS
  {
    printf 'Verdict start %s  status: %s\n' "$started" "$status"
    if [ "$status" = OK ]; then
      echo "Verdict dev environment ready. Run: npm run dev"
    else
      echo "Started WITH PROBLEMS (the codespace itself is fine):"
      for p in "${problems[@]}"; do echo "  - $p"; done
      if [ "${#details[@]}" -gt 0 ]; then
        echo
        echo "Last output of the failing step(s):"
        for d in "${details[@]}"; do printf '%s\n' "$d" | sed 's/^/    /'; done
      fi
      echo
      echo "Next: run 'bash scripts/doctor.sh', fix the cause, then re-run 'bash .devcontainer/start.sh'."
    fi
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$LOG" 2>/dev/null
  echo
  cat "$LOG" 2>/dev/null
}

# EXIT trap: always write the summary and force exit status 0, however the script ended. If it did not
# reach the end (internal error, interrupt, codespace stopping) that is recorded as a problem, never as OK.
completed=0
finish() {
  if [ "$completed" -ne 1 ]; then
    problems+=("The start script ended before finishing (internal error or interrupt), so the steps after that point did not run.")
  fi
  summary
  exit 0
}
trap finish EXIT
trap 'exit 0' INT TERM HUP   # exit 0 runs the EXIT trap above

# retry <label> <max_attempts> <no_retry_regex> <command...>
# Runs the command up to max_attempts times with increasing backoff. Output of the last attempt is left
# in RETRY_OUT. An output matching no_retry_regex is a permanent error: it is not retried.
retry() {
  local label=$1 max=$2 noretry=$3 attempt=1 delay=$RETRY_DELAY rc
  shift 3
  while :; do
    RETRY_OUT=$("$@" 2>&1); rc=$?
    printf '%s\n' "$RETRY_OUT"
    [ "$rc" -eq 0 ] && return 0
    if [ -n "$noretry" ] && printf '%s' "$RETRY_OUT" | grep -qE "$noretry"; then
      echo "$label failed with a non-transient error; not retrying."
      return "$rc"
    fi
    [ "$attempt" -ge "$max" ] && return "$rc"
    echo "$label: attempt $attempt/$max failed (exit $rc); retrying in ${delay}s..."
    sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 3))
  done
}

# Show the last start's outcome in every new interactive shell (idempotent).
install_shell_hook() {
  local repo marker='# >>> verdict last-start >>>' rc
  repo=$(pwd)
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || { [ "$rc" = "$HOME/.bashrc" ] && : > "$rc" 2>/dev/null; }
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    cat >> "$rc" <<EOF || echo "(could not add the last-start hook to $rc)"

$marker
case \$- in *i*) [ -f "$repo/.devcontainer/show-last-start.sh" ] && bash "$repo/.devcontainer/show-last-start.sh" ;; esac
# <<< verdict last-start <<<
EOF
  done
}
install_shell_hook

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
  # --wait blocks until the services are healthy (the postgres healthcheck is TCP-based). If it fails
  # (timeout, unhealthy, old compose) fall back to a plain 'up -d'; the readiness probe below is the
  # real gate either way.
  up_out=$(docker compose up -d --wait --wait-timeout 120 postgres redis 2>&1); up_rc=$?
  printf '%s\n' "$up_out"
  if [ "$up_rc" -ne 0 ]; then
    echo "'docker compose up --wait' did not succeed (exit $up_rc); falling back to plain 'up -d'."
    up_out=$(docker compose up -d postgres redis 2>&1); up_rc=$?
    printf '%s\n' "$up_out"
    if [ "$up_rc" -ne 0 ]; then
      note "'docker compose up -d postgres redis' failed. Try it by hand to see the error (image pull? port in use?)."
      detail "$(tail_of "$up_out")"
    fi
  fi
fi

# ── Wait for the services (short if Docker is down: nothing is going to start them) ────────────
pg_wait=90; redis_wait=30
if [ "$docker_ok" -ne 1 ]; then pg_wait=5; redis_wait=5; fi

# Postgres: a real probe (connect + auth + SELECT 1 with the app's DATABASE_URL), not just TCP.
pg_up=0
pg_out=$(node scripts/wait-for-postgres.js "$pg_wait" 2>&1); pg_rc=$?
printf '%s\n' "$pg_out"
case "$pg_rc" in
  0) pg_up=1 ;;
  2) note "The Postgres readiness probe cannot run: $(printf '%s\n' "$pg_out" | tail -n 1)"; detail "$(tail_of "$pg_out" 4)" ;;
  *) note "Postgres is not answering with the DATABASE_URL in backend/.env after ${pg_wait}s: $(printf '%s\n' "$pg_out" | tail -n 1)"; detail "$(tail_of "$pg_out" 6)" ;;
esac

# Redis: TCP is enough (BullMQ retries its own connection).
node scripts/wait-for-port.js localhost 6379 "$redis_wait" \
  || note "Redis is not accepting connections on localhost:6379 (nudge scheduling will not work)."

# ── Migrate (3 attempts) ───────────────────────────────────────────────────────────────────────
run_migrate() { (cd backend && npx prisma migrate deploy); }
migrated=0
if [ "$pg_up" -eq 1 ]; then
  # P3005 no history (db push), P3006/P3009/P3018 a migration failed: retrying cannot fix these.
  if retry "prisma migrate deploy" 3 'P3005|P3006|P3009|P3018' run_migrate; then
    migrated=1
  else
    if printf '%s' "$RETRY_OUT" | grep -q 'P3005'; then
      note "'prisma migrate deploy' failed with P3005: this database predates migrations. Easiest: recreate it ('docker compose down -v && docker compose up -d'). To keep the data, see the README section on db push."
    elif printf '%s' "$RETRY_OUT" | grep -qE 'P1000|P1001|P1003'; then
      note "'prisma migrate deploy' could not connect or authenticate after 3 attempts. Check DATABASE_URL in backend/.env against docker-compose.yml."
    else
      note "'prisma migrate deploy' failed (see the output above)."
    fi
    detail "$(tail_of "$RETRY_OUT")"
  fi
fi

# ── Seed (3 attempts) — only ever against an empty database ───────────────────────────────────
# The seed is not safe to re-run (it uses plain creates), so a retry first re-checks emptiness. If an
# earlier attempt of ours wrote data and then failed, that is reported as a partial seed, never skipped.
seed_if_empty() {
  local attempt=1 max=3 delay=$RETRY_DELAY tried=0 status users out rc
  while :; do
    if status=$(cd backend && node ../scripts/db-status.js 2>&1); then
      users=$(printf '%s' "$status" | sed -n 's/.*"users":\([0-9]*\).*/\1/p')
      if [ "${users:-}" != "0" ]; then
        if [ "$tried" -eq 1 ]; then
          note "The seed failed partway (${users:-?} users exist now). Recreate the dev database ('docker compose down -v && docker compose up -d') and start again."
          return 1
        fi
        echo "Database already has data (${users:-?} users); not seeding."
        return 0
      fi
      tried=1
      out=$(cd backend && npx prisma db seed 2>&1); rc=$?
      printf '%s\n' "$out"
      [ "$rc" -eq 0 ] && return 0
      detail "$(tail_of "$out")"
    else
      detail "$(tail_of "$status" 4)"
      if [ "$attempt" -ge "$max" ]; then note "Could not read the database before seeding: $(printf '%s\n' "$status" | tail -n 1)"; return 1; fi
    fi
    if [ "$attempt" -ge "$max" ]; then note "'prisma db seed' failed after $max attempts."; return 1; fi
    echo "seed: attempt $attempt/$max failed; retrying in ${delay}s..."
    sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 3))
  done
}
[ "$migrated" -eq 1 ] && seed_if_empty

completed=1
exit 0
