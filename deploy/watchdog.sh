#!/usr/bin/env bash
# FS-E2 — watchdog: probe the live gateway's three hard signals and exit
# NONZERO (with a human message) so systemd OnFailure= / cron can alert.
#
# FS-G3 — multi-signal alarmering (§8(c)): on every failure exit path the
# same failure is ALSO POSTed as JSON to $TG_ALERT_URLS (comma-separated)
# when that env is set, via curl --max-time 5. The POST is strictly
# best-effort: a failing webhook can NEVER change the exit code. Payload:
#   {"type":"watchdog_fail","ts":<epoch-ms>,"host":"<hostname>",
#    "fields":{"check":<healthz|chain|disk|data_dir|disk_usage>,"detail":"...","port":"..."}}
# Only counts/types — no secrets, no tokens, never request bodies.
#
# Checks:
#   1. /healthz answers ok:true                (gateway up)
#   2. chain.verify ok flag inside /healthz    (audit chain intact)
#   3. data-dir disk usage under threshold     (disk not full)
#
# Env: PORT (default 8800), TG_DATA_DIR (default <repo>/data),
#      TG_DISK_MAX_PCT (default 90), TG_ALERT_URLS (optional webhook targets),
#      TG_ALERT_TOKEN (optional Bearer for the webhook POST).
#      Secrets are NOT needed for the probes themselves — /healthz is
#      unauthenticated by design; TG_ALERT_TOKEN only authenticates the alarm.
# Exit 0 = all green. Exit 1 = first failing check (message on stderr).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8800}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="${TG_DATA_DIR:-$REPO/data}"
MAX_PCT="${TG_DISK_MAX_PCT:-90}"

# FS-G3: best-effort webhook alert. Never changes the exit code, never blocks
# longer than 5s per URL, never sends secrets (check name + detail only).
alert_fail() {
  local check="$1"
  local detail="$2"
  [ -z "${TG_ALERT_URLS:-}" ] && return 0
  local payload
  payload="$(node -e '
    const check = process.argv[1], detail = process.argv[2], port = process.argv[3];
    process.stdout.write(JSON.stringify({
      type: "watchdog_fail",
      ts: Date.now(),
      host: require("node:os").hostname(),
      fields: { check, detail: String(detail).slice(0, 200), port }
    }));
  ' "$check" "$detail" "$PORT" 2>/dev/null || true)"
  [ -z "$payload" ] && return 0
  local auth=()
  [ -n "${TG_ALERT_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${TG_ALERT_TOKEN}")
  local IFS=','
  for url in $TG_ALERT_URLS; do
    url="$(printf '%s' "$url" | tr -d '[:space:]')"
    [ -z "$url" ] && continue
    curl -fsS --max-time 5 -H 'content-type: application/json' \
      "${auth[@]}" -d "$payload" "$url" >/dev/null 2>&1 || true
  done
  return 0
}

# ── 1. /healthz must answer and carry ok:true ──
body="$(curl -fsS --max-time 5 "$BASE/healthz" 2>/dev/null || true)"
if [ -z "$body" ]; then
  echo "watchdog: FAIL — /healthz unreachable at $BASE (gateway down or hung?)" >&2
  alert_fail "healthz" "/healthz unreachable at $BASE"
  exit 1
fi
if ! printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).ok===true?0:1))' 2>/dev/null; then
  echo "watchdog: FAIL — /healthz answered but ok!=true at $BASE" >&2
  alert_fail "healthz" "/healthz answered but ok!=true"
  exit 1
fi
echo "watchdog: /healthz ok"

# ── 2. audit chain verify flag inside the same /healthz body ──
if ! printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).chain&&JSON.parse(s).chain.ok===true?0:1)}catch{process.exit(1)}})' 2>/dev/null; then
  echo "watchdog: FAIL — audit chain verify is NOT ok (tamper or corrupt audit store?)" >&2
  alert_fail "chain" "audit chain verify is NOT ok"
  exit 1
fi
echo "watchdog: chain verify ok"

# ── 3. data-dir disk usage under threshold ──
if [ ! -d "$DATA_DIR" ]; then
  echo "watchdog: FAIL — data dir missing: $DATA_DIR" >&2
  alert_fail "data_dir" "data dir missing: $DATA_DIR"
  exit 1
fi
pct="$(df --output=pcent "$DATA_DIR" | tail -1 | tr -dc '0-9')"
if [ -z "$pct" ]; then
  echo "watchdog: FAIL — could not read disk usage for $DATA_DIR" >&2
  alert_fail "disk_usage" "could not read disk usage for $DATA_DIR"
  exit 1
fi
if [ "$pct" -ge "$MAX_PCT" ]; then
  echo "watchdog: FAIL — disk ${pct}% full (threshold ${MAX_PCT}%): $DATA_DIR" >&2
  alert_fail "disk" "disk ${pct}% full (threshold ${MAX_PCT}%)"
  exit 1
fi
echo "watchdog: disk ok (${pct}%)"

echo "watchdog: PASS"
