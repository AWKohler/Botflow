#!/bin/zsh
# Launched by the io.botflow.canary.* LaunchAgents (see install.sh).
# Updates the sparse checkout of scripts/canary from main, then runs the
# canary with an exclusive lock so a slow run never overlaps the next one.
set -u
ROOT="${CANARY_HOME:-$HOME/botflow-canary}"
NODE="$(cat "$ROOT/node-path" 2>/dev/null)"
SUITE="${1:-daily}"
LOCK="$ROOT/state/run.lock"

mkdir -p "$ROOT/state/logs"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Stale lock (crashed run) older than 3h → take it over.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
    rm -rf "$LOCK" && mkdir "$LOCK"
  else
    echo "[$(date -u +%FT%TZ)] another canary run holds the lock; skipping $SUITE"
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

if ! git -C "$ROOT/repo" pull -q --ff-only origin main 2>&1; then
  echo "[$(date -u +%FT%TZ)] git pull failed; running the existing checkout"
fi

exec "$NODE" "$ROOT/repo/scripts/canary/canary.mjs" "$SUITE"
