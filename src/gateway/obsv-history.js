'use strict';
// FS-K3 — observability historical snapshots.
//
// captureSnapshot(snapshot, now) persists the obsv.js snapshot JSON to
// obsv_snapshots (id PK, captured_at, snapshot TEXT). Configurable via
// TG_OBSV_SNAPSHOT_INTERVAL_MS (default 300000 = 5min) and
// TG_OBSV_SNAPSHOT_RETENTION (default 288 = 24h at 5min). A timer set up
// at boot captures snapshots automatically when TG_OBSV_HISTORY=1; manual
// capture via the operator endpoint.
//
// Inert (no table, no timer, capture returns null) when TG_OBSV_HISTORY
// unset — byte-identical legacy.

const { db } = require('./db');

const TABLE = 'obsv_snapshots';
const MAX_SNAPSHOT_BYTES = 64 * 1024; // 64KB cap per snapshot

let _tableReady = false;
let _tableReadyConn = null;

function _ensureTable(conn) {
  // Re-create only if the connection changed (new DB file after TG_DB_FILE change)
  if (_tableReady && _tableReadyConn === conn) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      snapshot    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_captured_at ON ${TABLE}(captured_at);
  `);
  _tableReady = true;
  _tableReadyConn = conn;
}

function enabled() {
  return process.env.TG_OBSV_HISTORY === '1';
}

function intervalMs() {
  const raw = process.env.TG_OBSV_SNAPSHOT_INTERVAL_MS;
  if (raw === undefined) return 5 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 5 * 60 * 1000;
  return n;
}

function retention() {
  const raw = process.env.TG_OBSV_SNAPSHOT_RETENTION;
  if (raw === undefined) return 288;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 288;
  return n;
}

function _scrub(snapshot) {
  // Strip any accidental secret/key material before persisting.
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const scrubbed = { ...snapshot };
  // Remove known sensitive fields if present
  for (const k of Object.keys(scrubbed)) {
    if (/token|key|secret|password|credential/i.test(k)) delete scrubbed[k];
  }
  return scrubbed;
}

/** Capture one snapshot. Returns {id, capturedAt} or null if inert. */
function captureSnapshot(snapshot, now) {
  if (!enabled()) return null;
  _ensureTable(db);
  const at = Number.isFinite(now) ? now : Date.now();
  const cleaned = _scrub(snapshot);
  const json = JSON.stringify(cleaned);
  if (json.length > MAX_SNAPSHOT_BYTES) {
    return { error: 'snapshot_too_large', bytes: json.length };
  }
  const info = db.prepare(
    `INSERT INTO ${TABLE}(captured_at, snapshot) VALUES(?, ?)`
  ).run(at, json);
  return { id: Number(info.lastInsertRowid), capturedAt: at };
}

/** Query historical snapshots. Filters: since, until, limit (default 100, max 1000). */
function queryHistory({ since, until, limit } = {}) {
  if (!enabled()) return [];
  _ensureTable(db);
  const clauses = [];
  const params = [];
  if (Number.isFinite(since)) { clauses.push('captured_at >= ?'); params.push(since); }
  if (Number.isFinite(until)) { clauses.push('captured_at <= ?'); params.push(until); }
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const lim = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, 1000));
  const rows = db.prepare(
    `SELECT id, captured_at, snapshot FROM ${TABLE} ${where} ORDER BY captured_at DESC LIMIT ?`
  ).all(...params, lim);
  return rows.map(r => ({
    id: r.id,
    capturedAt: r.captured_at,
    snapshot: (() => { try { return JSON.parse(r.snapshot); } catch { return null; } })(),
  }));
}

/** Delete snapshots older than retention hours. Returns {deletedCount}. */
function cleanupOldSnapshots(now) {
  if (!enabled()) return { deletedCount: 0 };
  _ensureTable(db);
  const at = Number.isFinite(now) ? now : Date.now();
  const cutoff = at - retention() * (intervalMs());
  const info = db.prepare(
    `DELETE FROM ${TABLE} WHERE captured_at < ?`
  ).run(cutoff);
  return { deletedCount: Number(info.changes || 0) };
}

/** Most recent N snapshot lengths (for trend detection in obsv-alerts). */
function recentLengths(n = 3) {
  if (!enabled()) return [];
  _ensureTable(db);
  const rows = db.prepare(
    `SELECT captured_at, snapshot FROM ${TABLE} ORDER BY captured_at DESC LIMIT ?`
  ).all(n);
  return rows.map(r => {
    try {
      const s = JSON.parse(r.snapshot);
      return { capturedAt: r.captured_at, chainLength: s?.chain?.length ?? null };
    } catch { return { capturedAt: r.captured_at, chainLength: null }; }
  });
}

module.exports = {
  enabled,
  captureSnapshot,
  queryHistory,
  cleanupOldSnapshots,
  recentLengths,
  MAX_SNAPSHOT_BYTES,
};
