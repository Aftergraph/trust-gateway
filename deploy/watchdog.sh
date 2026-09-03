#!/usr/bin/env bash
# FS-E2 — watchdog: probe the live gateway's three hard signals and exit
# NONZERO (with a human message) so systemd OnFailure= / cron can alert.
#
# Checks:
#   1. /healthz answers ok:true                (gateway up)
#   2. chain.verify ok flag inside /healthz    (audit chain intact)
#   3. data-dir disk usage under threshold     (disk not full)
#
# Env: PORT (default 8800), TG_DATA_DIR (default <repo>/data),
#      TG_DISK_MAX_PCT (default 90). Secrets are NOT needed here and are never
#     read — /healthz is unauthenticated by design.
# Exit 0 = all green. Exit 1 = first failing check (message on stderr).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="${TG_DATA_DIR:-$REPO/data}"
MAX_PCT="${TG_DISK_MAX_PCT:-90}"

# ── 1. /healthz must answer and carry ok:true ──
body="$(curl -fsS --max-time 5 "$BASE/healthz" 2>/dev/null || true)"
if [ -z "$body" ]; then
  echo "watchdog: FAIL — /healthz unreachable at $BASE (gateway down or hung?)" >&2
  exit 1
fi
if ! printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).ok===true?0:1))' 2>/dev/null; then
  echo "watchdog: FAIL — /healthz answered but ok!=true at $BASE" >&2
  exit 1
fi
echo "watchdog: /healthz ok"

# ── 2. audit chain verify flag inside the same /healthz body ──
if ! printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).chain&&JSON.parse(s).chain.ok===true?0:1)}catch{process.exit(1)}})' 2>/dev/null; then
  echo "watchdog: FAIL — audit chain verify is NOT ok (tamper or corrupt audit store?)" >&2
  exit 1
fi
echo "watchdog: chain verify ok"

# ── 3. data-dir disk usage under threshold ──
if [ ! -d "$DATA_DIR" ]; then
  echo "watchdog: FAIL — data dir missing: $DATA_DIR" >&2
  exit 1
fi
pct="$(df --output=pcent "$DATA_DIR" | tail -1 | tr -dc '0-9')"
if [ -z "$pct" ]; then
  echo "watchdog: FAIL — could not read disk usage for $DATA_DIR" >&2
  exit 1
fi
if [ "$pct" -ge "$MAX_PCT" ]; then
  echo "watchdog: FAIL — disk ${pct}% full (threshold ${MAX_PCT}%): $DATA_DIR" >&2
  exit 1
fi
echo "watchdog: disk ok (${pct}%)"

echo "watchdog: PASS"
