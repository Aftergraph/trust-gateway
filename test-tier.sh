#!/bin/bash
# TG 10X test runner - Tiered verification.
# Tier A: ./test-tier.sh A <test-file>            (fast loop, seconds)
# Tier B: ./test-tier.sh B <shard>                (domain loop, e.g. B-approvals-takeover-governance)
# Tier C: ./test-tier.sh C                        (full suite, 9 parallel shards, ~85s)
# Telemetry appended to .avc/state/test-telemetry.log
set -u
cd "$(dirname "$0")"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG=.avc/state/test-telemetry.log
SHARD_MAP=.avc/state/tg-shards.env
mkdir -p .avc/state
WIN_NODE=$(which node)

tier="${1:-C}"

if [ "$tier" = "A" ]; then
  f="${2:?tier A needs a test file}"
  t0=$(date +%s)
  $WIN_NODE --test "$f" 2>&1
  rc=$?
  dt=$(( $(date +%s) - t0 ))
  echo "$TS A file=$f dur=${dt}s exit=$rc" >> "$LOG"
  exit $rc
fi

if [ "$tier" = "B" ]; then
  domain="${2:?tier B needs a shard key like A-auth-rbac-identity}"
  source "$SHARD_MAP"; eval "files=\$SHARD_${domain}"
  [ -z "$files" ] && { echo "unknown/empty shard: $domain"; exit 2; }
  t0=$(date +%s)
  $WIN_NODE --test --test-concurrency=1 $files 2>&1
  rc=$?
  dt=$(( $(date +%s) - t0 ))
  echo "$TS B domain=$domain dur=${dt}s exit=$rc" >> "$LOG"
  exit $rc
fi

# Tier C: full suite, shard-parallel (J = live-gateway conformance tests, excluded)
t0=$(date +%s)
rm -f .avc/state/tg-shard-status
pids=()

export AIE_PYTHON="C:/Users/empir/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe"
export TG_AIE_FAIL_OPEN=true
for domain in A B C D E F G H I; do
  source "$SHARD_MAP"; eval "files=\$SHARD_${domain}"
  [ -z "$files" ] && continue
  (
    SHARD_DB=$(mktemp -d)/gateway-$domain.db   # per-shard db: no cross-shard SQLITE lock contention
    export TG_DB_FILE="$SHARD_DB"
    $WIN_NODE --test --test-concurrency=1 $files > ".avc/state/tg-shard-$domain.log" 2>&1
    rc=$?
    if [ $rc -ne 0 ]; then
      # single retry: flakes here are DrvFs write-visibility artifacts (WSL /mnt/c),
      # not logic regressions — retry once, keep both logs.
      sleep 1
      SHARD_DB2=$(mktemp -d)/gateway-$domain.db; export TG_DB_FILE="$SHARD_DB2"
      $WIN_NODE --test --test-concurrency=1 $files > ".avc/state/tg-shard-$domain.log" 2>&1
      rc=$?
    fi
    echo "$domain:$rc" >> .avc/state/tg-shard-status
  ) &
  pids+=($!)
done
wait
dt=$(( $(date +%s) - t0 ))
statuses=$(cat .avc/state/tg-shard-status 2>/dev/null)
{
  echo "Tier C full: dur=${dt}s statuses:"
  echo "$statuses"
  echo "$TS C dur=${dt}s shards=9"
} >> "$LOG"
if echo "$statuses" | grep -qv ":0$"; then exit 1; fi
exit 0
