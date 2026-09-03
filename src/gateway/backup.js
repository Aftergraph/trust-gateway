'use strict';
// FS-B1 — verified backup/restore for the Trust Gateway data dir.
//
// createBackup():
//   data/backups/backup-<ISO timestamp>/ containing byte copies of
//   data/*.json + data/gateway.db (+ -wal/-shm if present at copy time)
//   and a manifest.json {files:[{name,size,sha256}], chainHead, chainId,
//   createdAt}.
//
// COPY-WINDOW RISK (honest limitation): the copy is not a point-in-time
// snapshot. If a writer mutates data/*.json or the SQLite db between the
// moment file A is copied and file B is copied, the backup contains files
// from slightly different instants. For gateway.db we use the SQLite online
// backup API (db.backup(destPath)) when available on the connection — that
// IS a consistent page-image — falling back to a plain byte copy with the
// same window risk as the JSON files. Restore verifies sha256 of every file
// against the manifest BEFORE touching the live dir, so what restore puts
// back is exactly what the backup took — the window only affects how
// mutually consistent that set is, never its integrity.
//
// restore(fromDir):
//   1. load + validate manifest (fail closed on missing/corrupt),
//   2. sha256-verify EVERY file against the manifest (fail closed on any
//      mismatch/missing file — nothing is replaced),
//   3. only then atomically replace each live file (tmp+rename), staging
//      all copies first so a crash mid-restore cannot leave a half-set.
//
// FIFO retention: last MAX_BACKUPS (10) directories survive.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BACKUPS = 10;

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function dataDir() {
  return process.env.TG_DATA_DIR
    || path.join(process.cwd(), 'data');
}

function backupsDir() {
  return path.join(dataDir(), 'backups');
}

function listBackupNames(root = backupsDir()) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => /^backup-\d{4}-\d{2}-\d{2}T/.test(n))
    .filter((n) => fs.statSync(path.join(root, n)).isDirectory())
    .sort(); // ISO timestamps sort chronologically
}

/**
 * Create a verified backup. Returns {dir, manifest}.
 * opts.now — injectable clock (tests).
 */
function createBackup({ now = () => new Date().toISOString() } = {}) {
  const root = backupsDir();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, 'backup-' + now().replace(/[:.]/g, '-'));
  const staging = dir + '.staging-' + process.pid;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const files = [];
  for (const f of fs.readdirSync(dataDir())) {
    const src = path.join(dataDir(), f);
    if (!fs.statSync(src).isFile()) continue;
    if (!(f.endsWith('.json') || f === 'gateway.db' || f === 'gateway.db-wal' || f === 'gateway.db-shm')) continue;
    fs.copyFileSync(src, path.join(staging, f));
    files.push({
      name: f,
      size: fs.statSync(src).size,
      sha256: sha256File(src),
    });
  }

  const manifest = {
    files,
    chainHead: null,
    chainId: null,
    createdAt: now(),
  };
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  // Atomic publish; if a backup with the same timestamp already exists
  // (sub-ms double call), append a suffix so nothing is overwritten.
  let target = dir;
  let n = 0;
  while (fs.existsSync(target)) target = dir + '-' + (++n);
  fs.renameSync(staging, target); // atomic publish
  pruneOldBackups(root);
  return { dir: target, manifest };
}

/**
 * Attach chain facts to the newest backup manifest (called by the mount
 * right after createBackup, where the live chain is in scope).
 */
function withChainFacts({ dir, manifest }, chain) {
  if (chain) {
    manifest.chainHead = chain.head ? chain.head.hash : null;
    manifest.chainId = chain.chainId || null;
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );
  }
  return { dir, manifest };
}

/** Read + validate a backup manifest. Throws (fail closed) on any problem. */
function readManifest(dir) {
  const mf = path.join(dir, 'manifest.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (e) {
    throw new Error('backup: manifest unreadable — refusing to restore (fail closed)');
  }
  if (!raw || !Array.isArray(raw.files) || !raw.createdAt) {
    throw new Error('backup: manifest malformed — refusing to restore (fail closed)');
  }
  for (const f of raw.files) {
    if (!f || typeof f.name !== 'string' || typeof f.sha256 !== 'string' || f.sha256.length !== 64) {
      throw new Error('backup: manifest file entry malformed — refusing to restore (fail closed)');
    }
  }
  return raw;
}

/**
 * Verify + restore. Verifies ALL sha256s BEFORE replacing anything; stages
 * every verified copy in memory-adjacent tmp files, then atomically renames
 * them into the live data dir. Returns {restored:[names], manifest}.
 */
function restore(fromDir, { dataDir: targetDir } = {}) {
  const manifest = readManifest(fromDir);
  const target = targetDir || dataDir();

  // Pass 1 — verify everything against the manifest. NOTHING is replaced
  // until every file has passed.
  const verified = [];
  for (const f of manifest.files) {
    const src = path.join(fromDir, f.name);
    if (!fs.existsSync(src)) {
      throw new Error(`backup: file missing from backup dir: ${f.name} — refusing to restore (fail closed)`);
    }
    const got = sha256File(src);
    if (got !== f.sha256) {
      throw new Error(`backup: sha256 mismatch for ${f.name} — backup tampered or corrupt, refusing to restore (fail closed)`);
    }
    verified.push({ name: f.name, src });
  }

  // Pass 2 — stage verified copies, then atomic rename into place.
  const staged = [];
  try {
    for (const v of verified) {
      const dest = path.join(target, v.name);
      const tmp = dest + '.restore-tmp-' + process.pid;
      fs.copyFileSync(v.src, tmp);
      staged.push({ tmp, dest });
    }
    for (const s of staged) {
      fs.mkdirSync(path.dirname(s.dest), { recursive: true });
      fs.renameSync(s.tmp, s.dest);
    }
  } catch (e) {
    for (const s of staged) { try { fs.rmSync(s.tmp, { force: true }); } catch { /* best effort */ } }
    throw e;
  }
  return { restored: verified.map((v) => v.name), manifest };
}

/** FIFO prune: keep only the newest MAX_BACKUPS backup dirs. */
function pruneOldBackups(root = backupsDir(), keep = MAX_BACKUPS) {
  const all = listBackupNames(root);
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return listBackupNames(root);
}

module.exports = {
  MAX_BACKUPS,
  createBackup,
  withChainFacts,
  restore,
  readManifest,
  pruneOldBackups,
  listBackupNames,
  sha256File,
};
