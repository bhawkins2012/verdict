#!/usr/bin/env bash
# Print the outcome of the last .devcontainer/start.sh run, so a failed start cannot go unnoticed.
# Used by postAttachCommand and by a hook start.sh adds to your shell rc (every new terminal).
# Always exits 0.
LOG="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/.devcontainer/last-start.log"
if [ -t 1 ]; then R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'; else R=; Y=; D=; N=; fi

if [ ! -f "$LOG" ]; then
  echo "${Y}Verdict: .devcontainer/start.sh has not run yet.${N} Run: bash .devcontainer/start.sh"
  exit 0
fi

first=$(head -n 1 "$LOG")
case "$first" in
  *"status: OK") printf '%s%s%s\n' "$D" "$first" "$N" ;;
  *"status: RUNNING") echo "${Y}${first}${N}"
    echo "  Still starting, or it was interrupted. If it stays like this: bash .devcontainer/start.sh" ;;
  *) echo "${R}${first}${N}"; tail -n +2 "$LOG" ;;
esac
exit 0
