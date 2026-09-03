# Trust Gateway — Operator Runbook (2026-09-03)

Concrete procedures for the running system. Every command below exists in
this repo or on the installed VDS. Service facts: `tg-gateway.service`
(systemd, enabled, `Restart=always`, 2s), daily backup at 04:00
(`tg-backup.timer`), data dir `/root/agent-workforce/data/`.

## Daily operation

```bash
systemctl status tg-gateway          # active/failed, PID, restarts
curl -s http://127.0.0.1:8800/healthz | jq .   # ok:true + chain.verify
bash deploy/status.sh                # human summary (SEALED + pending)
bash scripts/conformance-tier-a.sh   # 9-domain smoke gate
bash scripts/conformance-tier-b.sh   # deep behavioral battery
bash scripts/conformance-tier-c.sh   # chaos battery (root; tmpfs scenario)
```

Logs: `journalctl -u tg-gateway -f` (systemd era) — legacy `data/gateway.log`
only existed under nohup.

## Failure mode 1 — chain verify fails

Symptom: `GET /v1/audit/verify` → `ok:false`, or watchdog exits nonzero.

1. STOP the gateway: `systemctl stop tg-gateway` (do not let it seal onto a
   broken chain).
2. Identify the damage: `tail -5 data/audit.jsonl` (if JSONL mode) or
   `sqlite3 data/gateway.db 'SELECT seq FROM chain_entries ORDER BY seq DESC LIMIT 3'`.
   - Trailing PARTIAL line (crash artifact): disk-audit drops it and rewrites
     on next boot — safe to restart.
   - Tampered INTERIOR line: STOP. The chain is the evidence trail — restore
     from backup (mode 3) and treat the interval as under investigation. The
     chain's purpose is to make tampering loud, not to self-heal it away.
3. Restore from the newest verified backup if integrity is in doubt:
   `curl -X POST localhost:8800/v2/backup/restore -H "authorization: Bearer $ATLAS" -d '{"name":"<backup-id>"}'`
   — restore verifies every sha256 BEFORE replacing anything and refuses
   (409) on mismatch.

## Failure mode 2 — disk full

MEASURED behavior (tier-C chaos, this host): audit append under ENOSPC
kills the process (exit 1) — fail-closed: no partial entry is ever written,
but the gateway is DOWN, not refusing.

1. `systemctl is-active tg-gateway` will crash-loop (Restart=always).
2. Free space: `df -h /root/agent-workforce/data`; prune old backups
   (FIFO keeps 10), old journals (`journalctl --vacuum-size=100M`).
3. `systemctl start tg-gateway` — chain verifies; disk-audit drops any
   crash artifact; nothing is half-written.

## Failure mode 3 — gateway crash-loops

1. `journalctl -u tg-gateway -n 50 --no-pager` — read the ACTUAL error
   (boot-time ENOSPC = disk full; SQLITE_BUSY on db file = a second
   gateway is running against the same file; EADDRINUSE = port conflict).
2. Two-gateways-on-one-db is NOT a supported deployment: `pgrep -af
   gateway.js` and kill the extra process (tier-C proves WAL survives the
   race without corruption, but the loser exits).
3. After fixing the cause: `systemctl restart tg-gateway` and verify
   `/healthz` + `/v1/audit/verify`.

## Failure mode 4 — restore needed

Verified procedure (tier-C tested):

1. `systemctl stop tg-gateway`
2. Choose backup: `ls data/backups/` (FIFO, newest last) — each has
   `manifest.json` with per-file sha256 + the chainHead at backup time.
3. Dry integrity check: `bash deploy/restore-drill.sh` — proves the
   machinery fail-closed on a deliberately corrupt backup before you touch
   real data.
4. Restore: `POST /v2/backup/restore {name}` (operator token) — verifies
   ALL sha256s first; refuses 409 on ANY mismatch. Live files are replaced
   only after every check passes.
5. `systemctl start tg-gateway` → `/healthz` → chain verify. The chainHead
   in the restored manifest matches the head the backup saw; entries after
   that point are gone by design (document the gap, don't hide it).

## §5 Archive restore drill — restore archived chain entries (FS-J3)

`chain-archive.js` also ships a checksummed RE-IMPORT: archived entries can
be brought back into the live chain, fail-closed, by manifest key. Same
env gate as archival (`TG_CHAIN_ARCHIVE=1`; unset = fully inert).

Endpoints (operator-only, like everything under /v2/chain/archive):

- `GET /v2/chain/archive` — list manifests (see what exists)
- `GET /v2/chain/archive/:date` — manifest details BEFORE restore: file,
  count, sha256, headBefore/headAfter, any prior restore
- `POST /v2/chain/archive/:date/restore` — run the restore

Drill (use a maintenance window; the restore appends entries to the LIVE
chain):

1. Pick a manifest: `curl -s localhost:8800/v2/chain/archive -H "authorization: Bearer ***" | jq .`
2. Inspect it BEFORE restoring: `curl -s localhost:8800/v2/chain/archive/<date> -H "authorization: Bearer ***"`
   — check `count` (how many entries would come back), `sha256`, and
   `lastRestore` (was this archive already restored?).
3. Restore: `curl -s -X POST localhost:8800/v2/chain/archive/<date>/restore -H "authorization: Bearer ***"`
   → `{restoredCount, skippedDuplicates, newHead}` on 200.
4. Verify: `curl -s localhost:8800/v1/audit/verify | jq .ok` must be `true` —
   restored entries are re-appended at the current head with recomputed
   seq/prevHash/hash, so the chain verifies GREEN end-to-end.
5. Re-run safety: a second restore of the same manifest is a clean no-op
   (`restoredCount: 0, skippedDuplicates: N`) — duplicates are skipped by
   content identity, and nothing else in the chain changes.

What refuses, and how loudly:

- Manifest missing / unreadable, archive file deleted, malformed entries,
  or a sha256 mismatch between manifest and disk → the restore THROWS
  before touching the live DB; the mount answers 409
  `restore_refused` and audits `chain_restore_refused`. A checksum
  mismatch means the archive is corrupt or tampered — investigate, do not
  retry.
- Bloat guard: if the live chain already has >1000 entries AND the restore
  would push it past 10000 total, the restore refuses with
  `bloat_guard` (409). This is deliberate — one mistyped manifest must
  not inflate the live chain tenfold. If you truly need it, restore in
  stages or lower the archive's `count` by splitting the file first.
- Non-operator tokens get 403 + `chain_restore_refused` (RBAC), and with
  `TG_CHAIN_ARCHIVE` unset everything answers 501 `archive_disabled`
  (inert — nothing is read, written, or audited).

Every restore outcome is audited with counts and hashes only:
`chain_restored` (TRANSPARENCY.md row 142) or `chain_restore_refused`
(row 143) — never entry payloads, never file contents.

## Chaos reference (measured 2026-09-03, this host)

- kill -9 ×N mid-park: approvals survive (durable file), chain monotonic,
  verify ok. Tier-C scenario (a) ✓
- Two gateways, one SQLite file (WAL): no corruption (seq contiguous,
  prevHash-linked) — but single-writer-per-db is the contract; a second
  gateway on the same file is an operator error (tier-C scenario (b)).
- ENOSPC: process exits 1 — fail closed. Tier-C scenario (c) ✓
- Restart storm ×5: healthz recovers every time, chain monotonic. Tier-C
  scenario (d) ✓
