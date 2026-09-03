'use strict';
// FS-I7 — chain compaction / archival (age-based, env-gated, fail-closed).
//
// Moves chain entries older than TG_CHAIN_ARCHIVE_DAYS (default 90) out of
// the live SQLite chain into data/archive/chain-<date>.jsonl (append-only,
// sha256-checksummed), deletes them from the live DB, and re-bases the
// surviving entries so SqlChain.verify() stays GREEN (seq contiguous,
// prevHash-linked from genesis). The head change is DOCUMENTED, not hidden:
// the manifest records headBefore (the pre-archival head, reproducible by
// replaying the archived file) and headAfter (the post-rebase head) — the
// same honesty contract as the backup/restore gap (docs/RUNBOOK.md, mode 4).
//
//   TG_CHAIN_ARCHIVE=1        enables archival (unset = INERT: nothing is
//                             read, written, deleted or audited)
//   TG_CHAIN_ARCHIVE_DAYS=90  age threshold in days (default 90)
//
// Safety: archival REFUSES while the live chain has fewer than 100 entries
// — a short chain is indistinguishable from "almost everything is old" and
// compaction must never be able to wipe a young chain by accident.
//
// Zero deps: node:crypto, node:fs, node:path + the chain's own connection.
// The manifest lives in kv_store under 'archive:chain:<date>' so operators
// list archives without touching the filesystem.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { entryHash } = require('./hash-chain');
const { KV } = require('./kvstore');

const MIN_CHAIN_LENGTH = 100;

function archiveEnabled() {
  return process.env.TG_CHAIN_ARCHIVE === '1';
}

function archiveDays() {
  const n = Number(process.env.TG_CHAIN_ARCHIVE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

function defaultArchiveDir() {
  return path.join(process.cwd(), 'data', 'archive');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify an archived JSONL file: every entry re-hashes to its own hash and
 * each entry links to the previous one. Returns {ok, count, head} — head is
 * the LAST entry's hash, which must equal the manifest's headBefore.
 */
function verifyArchiveFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let prev = null;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { return { ok: false, reason: 'bad_json', count: lines.length }; }
    if (typeof e.seq !== 'number' || typeof e.hash !== 'string')
      return { ok: false, reason: 'bad_entry', count: lines.length };
    if (prev && e.prevHash !== prev.hash)
      return { ok: false, reason: 'link_break_at_' + e.seq, count: lines.length };
    const expected = entryHash(e.seq, e.prevHash, e.ts, e.payload);
    if (e.hash !== expected)
      return { ok: false, reason: 'hash_mismatch_at_' + e.seq, count: lines.length };
    prev = e;
  }
  return { ok: true, count: lines.length, head: prev ? prev.hash : null };
}

/**
 * Archive chain entries with ts < beforeTimestamp.
 *
 * @param {number} [beforeTimestamp] epoch ms cutoff (default: now − TG_CHAIN_ARCHIVE_DAYS)
 * @param {object} [opts]
 * @param {object} opts.chain         the live SqlChain instance (REQUIRED —
 *                                    archival is a SQL-chain operation; a
 *                                    JSONL HashChain has nothing to delete)
 * @param {object} [opts.kv]          KV store for the manifest (default: KV
 *                                    over the chain's own connection)
 * @param {string} [opts.archiveDir]  default data/archive under cwd
 * @param {() => number} [opts.now]
 * @returns {{inert?|refused?|archivedCount, manifestKey?, manifest?}}
 */
function archiveChain(beforeTimestamp, opts = {}) {
  // Env gate FIRST — unset TG_CHAIN_ARCHIVE means this function is inert.
  if (!archiveEnabled()) return { inert: true, archivedCount: 0 };

  const chain = opts.chain;
  if (!chain || !chain.db)
    return { refused: true, reason: 'sql_chain_required' };

  const now = opts.now || (() => Date.now());
  const cutoff =
    typeof beforeTimestamp === 'number'
      ? beforeTimestamp
      : now() - archiveDays() * 24 * 60 * 60 * 1000;

  const headBefore = chain.head ? chain.head.hash : null;
  const length = chain.length;

  const db = chain.db;
  const oldRows = db
    .prepare(
      'SELECT seq, ts, prev_hash, hash, payload FROM chain_entries WHERE ts < ? AND seq > 0 ORDER BY seq ASC'
    )
    .all(cutoff);
  const oldEntries = oldRows.map((r) => chain._rowToEntry(r));

  // Idempotent: nothing old left (e.g. a re-run over the same period) is a
  // clean no-op — no file append, no manifest rewrite. Checked BEFORE the
  // length gate: deleting nothing cannot wipe a short chain.
  if (oldEntries.length === 0)
    return { archivedCount: 0, manifestKey: null };

  // Safety gate — refuse before ANY mutation or disk write: archival REFUSES
  // if the live chain has fewer than MIN_CHAIN_LENGTH entries, so compaction
  // can never wipe a young chain by accident (spec: "chain head < 100").
  if (length < MIN_CHAIN_LENGTH)
    return { refused: true, reason: 'chain_too_short', length };

  const archiveDir = opts.archiveDir || defaultArchiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });
  const date = new Date(now()).toISOString().slice(0, 10);
  const fileName = `chain-${date}.jsonl`;
  const filePath = path.join(archiveDir, fileName);

  // Append-only: an existing file for today keeps growing (multi-archive
  // days stay one file); every entry line carries its ORIGINAL seq/hashes,
  // so a replay of the file recomputes headBefore exactly.
  const payload = oldEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, payload, 'utf8');
  const fileSha256 = sha256Buf(fs.readFileSync(filePath));

  // Mutate live DB + write manifest atomically on the chain's connection.
  const kv =
    opts.kv ||
    new KV({
      db,
      table: 'kv_store',
    });
  const manifestKey = `archive:chain:${date}`;
  let manifest;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. delete archived rows (genesis seq 0 is NEVER deletable).
    db.prepare('DELETE FROM chain_entries WHERE ts < ? AND seq > 0').run(cutoff);

    // 2. re-base survivors: seq 1..N, prevHash-linked, hashes recomputed.
    //    Payloads and timestamps are untouched — only position/hash change,
    //    and the head change is recorded in the manifest (headBefore →
    //    headAfter). FTS triggers fire on UPDATE/DELETE and stay in sync.
    const keep = db
      .prepare(
        'SELECT seq, ts, payload FROM chain_entries WHERE seq > 0 ORDER BY seq ASC'
      )
      .all();
    let prevHash = (db
      .prepare('SELECT hash FROM chain_entries WHERE seq = 0')
      .get() || {}
    ).hash;
    if (!prevHash) prevHash = '0'.repeat(64);
    const upd = db.prepare(
      'UPDATE chain_entries SET seq = ?, prev_hash = ?, hash = ? WHERE seq = ?'
    );
    let newSeq = 0;
    for (const row of keep) {
      newSeq += 1;
      const h = entryHash(newSeq, prevHash, row.ts, JSON.parse(row.payload));
      upd.run(newSeq, prevHash, h, row.seq);
      prevHash = h;
    }

    const headAfter = prevHash;
    manifest = {
      file: filePath,
      count: oldEntries.length,
      headBefore,
      headAfter,
      archivedAt: new Date(now()).toISOString(),
      sha256: fileSha256,
      beforeTs: cutoff,
      chainId: chain.chainId,
    };
    kv.set(manifestKey, manifest);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  return { archivedCount: manifest.count, manifestKey, manifest };
}

module.exports = {
  archiveChain,
  verifyArchiveFile,
  archiveEnabled,
  archiveDays,
  MIN_CHAIN_LENGTH,
};
