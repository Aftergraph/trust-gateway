'use strict';
// FS-M3 — persistent rate-limit ledger.
//
// Sliding-window rate counters backed by the shared SQLite db.js. Each
// (bucketKey, window) maps to a row in rate_buckets; hit() atomically
// increments the current window's count and returns whether the request
// is allowed against maxHits.
//
// Inert when TG_RATE_LEDGER=0 (default ON). When disabled, hit() returns
// {count:0, allowed:true, retryAfterMs:0} (no enforcement) so callers
// degrade gracefully.

const { db, tx } = require('./db');

const TABLE = 'rate_buckets';

function enabled() {
  return process.env.TG_RATE_LEDGER !== '0';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      bucket_key   TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (bucket_key, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_key ON ${TABLE}(bucket_key);
  `);
}

function _windowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * @param {string} bucketKey
 * @param {number} windowMs
 * @param {number} maxHits
 * @param {number} now
 * @returns {object} {count, allowed, retryAfterMs}
 */
function hit(bucketKey, windowMs, maxHits, now) {
  if (!enabled()) return { count: 0, allowed: true, retryAfterMs: 0 };
  if (!bucketKey || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { count: 0, allowed: true, retryAfterMs: 0 };
  }
  if (!Number.isFinite(maxHits) || maxHits < 0) {
    maxHits = 0; // 0 = unlimited
  }
  _ensureTable();
  const at = Number.isFinite(now) ? now : Date.now();
  const wStart = _windowStart(at, windowMs);
  const newCount = tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(bucket_key, window_start, count, updated_at)
       VALUES(?, ?, 1, ?)
       ON CONFLICT(bucket_key, window_start) DO UPDATE SET
         count = count + 1,
         updated_at = excluded.updated_at`
    ).run(bucketKey, wStart, at);
    const r = db.prepare(
      `SELECT count FROM ${TABLE} WHERE bucket_key = ? AND window_start = ?`
    ).get(bucketKey, wStart);
    return r ? Number(r.count) : 0;
  });
  const allowed = maxHits === 0 || newCount <= maxHits;
  const retryAfterMs = allowed ? 0 : (wStart + windowMs - at);
  return { count: newCount, allowed, retryAfterMs };
}

function getCount(bucketKey, windowMs, now) {
  if (!enabled()) return 0;
  if (!bucketKey || !Number.isFinite(windowMs) || windowMs <= 0) return 0;
  _ensureTable();
  const at = Number.isFinite(now) ? now : Date.now();
  const wStart = _windowStart(at, windowMs);
  const r = db.prepare(
    `SELECT count FROM ${TABLE} WHERE bucket_key = ? AND window_start = ?`
  ).get(bucketKey, wStart);
  return r ? Number(r.count) : 0;
}

function reset(bucketKey) {
  if (!enabled()) return 0;
  if (!bucketKey) return 0;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE bucket_key = ?`).run(bucketKey);
  return Number(info.changes || 0);
}

module.exports = {
  enabled,
  hit,
  getCount,
  reset,
  TABLE,
};
