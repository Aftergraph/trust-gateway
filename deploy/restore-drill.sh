#!/usr/bin/env bash
# FS-E2 — restore drill: prove that backup restore() fails closed and that a
# GOOD backup round-trips byte-for-byte.
#
# Structure:
#   1. Build a SCRATCH live data dir (never touches the real data/), seed it,
#      and take a real backup with bin/backup-once.js.
#   2. CORRUPT a copy of that backup: keep the manifest valid, tamper one
#      file's bytes → restore() must FAIL (exit nonzero) and the live dir
#      must be byte-identical afterwards (fail closed: nothing replaced).
#   3. Restore the REAL latest backup into a SCRATCH copy of the live dir and
#      diff every restored file against the backup copy.
#
# Never operates on the live data dir: every restore targets a temp dir.
# Exit 0 = drill passed; nonzero = drill failed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/tg-restore-drill.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

LIVE="$WORK/live"        # stands in for the real data/ for this drill
SCRATCH="$WORK/scratch"  # restore target — always a scratch copy
FAIL() { echo "restore-drill: FAILED — $*" >&2; exit 1; }

# ── 1. seed a scratch live dir + take a real backup ──
# (createBackup covers *.json + gateway.db*; audit.jsonl is NOT backed up, so
#  the drill seeds and tamper-tests a *.json file that IS in the manifest.)
mkdir -p "$LIVE/backups"
printf '{"kv":1}' > "$LIVE/kvstore.json"
printf '{"goals":[]}' > "$LIVE/memory.json"
TG_DATA_DIR="$LIVE" node "$REPO/bin/backup-once.js" >/dev/null \
  || FAIL "backup-once.js failed on seeded dir"
BACKUP="$(ls -1d "$LIVE"/backups/backup-* | sort | tail -1)"
[ -f "$BACKUP/manifest.json" ] || FAIL "no manifest.json in $BACKUP"

# ── 2. corrupt drill: valid manifest, tampered file → restore must fail closed ──
CORRUPT="$WORK/corrupt-backup"
cp -r "$BACKUP" "$CORRUPT"
printf 'TAMPERED' >> "$CORRUPT/kvstore.json"   # valid manifest, corrupt bytes

cp -r "$LIVE" "$SCRATCH"   # snapshot live dir BEFORE the attempted restore
before="$(cd "$SCRATCH" && find . -type f ! -path './backups/*' -exec sha256sum {} + | sort)"

if TG_DATA_DIR="$SCRATCH" node -e '
  const { restore } = require(process.argv[1] + "/src/gateway/backup");
  try { restore(process.argv[2]); process.exit(0); }  // success would be a bug
  catch (e) { console.error(e.message); process.exit(3); }
' "$REPO" "$CORRUPT" 2>"$WORK/corrupt.err"; then
  FAIL "restore() accepted a TAMPERED backup — integrity check is broken"
fi  # reaching here means node exited nonzero on the tampered backup


after="$(cd "$SCRATCH" && find . -type f ! -path './backups/*' -exec sha256sum {} + | sort)"
[ "$before" = "$after" ] || FAIL "live data changed during failed restore — not fail closed"
grep -qi "fail closed" "$WORK/corrupt.err" || FAIL "corrupt restore failed for the wrong reason (no fail-closed message)"
echo "restore-drill: corrupt backup correctly REJECTED (fail closed, live data untouched)"

# ── 3. good-path drill: restore the real latest backup into a scratch copy ──
GOOD="$WORK/good-scratch"
cp -r "$LIVE" "$GOOD"
TG_DATA_DIR="$GOOD" node -e '
  const { restore } = require(process.argv[1] + "/src/gateway/backup");
  const fs = require("node:fs");
  const path = require("node:path");
  const backups = fs.readdirSync(path.join(process.env.TG_DATA_DIR, "backups"))
    .filter((n) => /^backup-\d{4}-\d{2}-\d{2}T/.test(n)).sort();
  const latest = path.join(process.env.TG_DATA_DIR, "backups", backups[backups.length - 1]);
  const r = restore(latest);
  console.log("restored:", r.restored.join(","));
' "$REPO" || FAIL "restore() rejected a VALID backup"

for f in kvstore.json memory.json; do
  cmp -s "$BACKUP/$f" "$GOOD/$f" || FAIL "restored $f differs from backup copy"
done
echo "restore-drill: valid backup restored byte-for-byte into scratch dir"
echo "restore-drill: PASS"
