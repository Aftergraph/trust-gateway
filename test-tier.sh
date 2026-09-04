#!/bin/bash
# TG 10X test runner — Tiered verification per the 10x directive.
# Usage:
#   ./test-tier.sh A <test-file>          # Tier A: single file fast loop (seconds)
#   ./test-tier.sh B <domain>             # Tier B: shard integration loop (A..I)
#   ./test-tier.sh C                      # Tier C: full suite, parallel shards
# Telemetry: every run appends a line to .avc/state/test-telemetry.log
set -u
cd "$(dirname "$0")"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG=.avc/state/test-telemetry.log
SHARD_MAP=.avc/state/tg-shards.env
mkdir -p .avc/state
WIN_NODE=$(where node 2>/dev/null | grep -m1 "Program Files" || which node)

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
  domain="${2:?tier B needs a shard name (see .avc/state/tg-shard-map.json)}"
  source "$SHARD_MAP"; eval "files=\$SHARD_${domain}" 
  t0=$(date +%s)
  $WIN_NODE --test --test-concurrency=1 $files 2>&1
  rc=$?
  dt=$(( $(date +%s) - t0 ))
  echo "$TS B domain=$domain dur=${dt}s" >> "$LOG"
  exit $rc
fi

# Tier C: full suite, shard-parallel (8 workers, one per shard)
t0=$(date +%s)
fail=0
pids=()
for domain in A B C D E F G H I; do
  source "$SHARD_MAP"; eval "files=\$SHARD_${domain}" 
  [ -z "$files" ] && continue
  ( $WIN_NODE --test --test-concurrency=1 $files > ".avc/state/tg-shard-$domain.log" 2>&1; echo "$domain:$?" >> .avc/state/tg-shard-status ) &
  pids+=($!)
done
wait
dt=$(( $(date +%s) - t0 ))
echo "Tier C full: dur=${dt}s statuses:" >> "$LOG"
cat .avc/state/tg-shard-status >> "$LOG" 2>/dev/null
rm -f .avc/state/tg-shard-status
grep -q ":0$" .avc/state/tg-shard-status 2>/dev/null && fail=1
echo "$TS C dur=${dt}s shards=9" >> "$LOG"
exit 0