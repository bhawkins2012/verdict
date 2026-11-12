#!/usr/bin/env bash
# Dependency installs only (runs once, from onCreateCommand). Idempotent.
# A failed install is reported but never fails this step: the container must always come up.
# Re-run it from a shell any time: bash .devcontainer/install-deps.sh
set -uo pipefail
cd "$(dirname "$0")/.."

failed=()
run() {
  local name=$1; shift
  echo "==> $name"
  "$@" || { failed+=("$name"); echo "!! $name FAILED"; }
}

run "root dependencies"     npm install --no-audit --no-fund
run "frontend dependencies" npm --prefix frontend install --no-audit --no-fund
run "backend dependencies"  npm --prefix backend install --no-audit --no-fund
run "ml dependencies"       python3 -m pip install -r ml/requirements.txt

if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo "!! Some installs failed: ${failed[*]}"
  echo "   The codespace is still usable. Fix the cause (usually network) and re-run:"
  echo "     bash .devcontainer/install-deps.sh"
  echo "   Then check the environment with: bash scripts/doctor.sh"
else
  echo "Dependencies installed."
fi
exit 0
