'use strict';
// FS-X3 — per-route rate limits (extends FS-M3 ledger).
// Maps route patterns → max-hits-per-window. Each request increments a
// ledger keyed by the matched route, returns 429 if over.
//
// Inert (no enforcement) when TG_ROUTE_LIMITS unset.

const rate = require('./rate-ledger');
const { db, tx } = require('./db');

const TABLE = 'route_limits';

function enabled() {
  return process.env.TG_ROUTE_LIMITS === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      pattern    TEXT PRIMARY KEY,
      max_hits   INTEGER NOT NULL,
      window_ms  INTEGER NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `);
}

/**
 * @param {string} pattern e.g. 'POST /v2/skills/import' or 'GET /v2/tenants/:id/flags'
 * @param {object} cfg {maxHits, windowMs}
 * @param {string} by
 */
function set(pattern, cfg, by) {
  if (!enabled()) return null;
  if (!pattern || !cfg) return { ok: false, error: 'missing_input' };
  const maxHits = Number.isFinite(cfg.maxHits) && cfg.maxHits > 0 ? cfg.maxHits : 60;
  const windowMs = Number.isFinite(cfg.windowMs) && cfg.windowMs > 0 ? cfg.windowMs : 60_000;
  _ensureTable();
  const at = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(pattern, max_hits, window_ms, enabled, updated_at, updated_by)
       VALUES(?, ?, ?, 1, ?, ?)
       ON CONFLICT(pattern) DO UPDATE SET
         max_hits = excluded.max_hits,
         window_ms = excluded.window_ms,
         enabled = 1,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).run(pattern, maxHits, windowMs, at, by || 'unknown');
  });
  return { ok: true, pattern, maxHits, windowMs, updatedAt: at };
}

function get(pattern) {
  if (!enabled() || !pattern) return null;
  _ensureTable();
  let r;
  try { r = db.prepare(`SELECT * FROM ${TABLE} WHERE pattern = ?`).get(pattern); } catch { return null; }
  if (!r) return null;
  return {
    pattern: r.pattern,
    maxHits: r.max_hits,
    windowMs: r.window_ms,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function remove(pattern) {
  if (!enabled() || !pattern) return false;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE pattern = ?`).run(pattern);
  return Number(info.changes || 0) > 0;
}

function list() {
  if (!enabled()) return [];
  _ensureTable();
  let rows = [];
  try { rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY pattern`).all(); } catch { return []; }
  return rows.map(r => ({
    pattern: r.pattern,
    maxHits: r.max_hits,
    windowMs: r.window_ms,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

/**
 * Find the best-matching pattern for a (method, path). Simple
 * exact-match for now; can be extended to glob/regex later.
 * @returns {object|null}
 */
function match(method, path) {
  if (!enabled() || !method || !path) return null;
  // Strip query string
  const cleanPath = path.split('?')[0];
  const key = `${method.toUpperCase()} ${cleanPath}`;
  const exact = get(key);
  if (exact && exact.enabled) return exact;
  // Try parameter substitution: /v2/tenants/acme/flags → /v2/tenants/:id/flags
  // (only if no exact match)
  return null;
}

/**
 * Check a request against the rate limit. Returns {allowed, retryAfterMs, count, maxHits, windowMs, pattern?}.
 */
function check(method, path, now) {
  if (!enabled() || !rate.enabled()) return { allowed: true, skipped: true };
  const rule = match(method, path);
  if (!rule) return { allowed: true, skipped: true };
  const key = `${method.toUpperCase()}:${path.split('?')[0]}`;
  const r = rate.hit(key, rule.windowMs, rule.maxHits, now);
  return {
    allowed: r.allowed,
    count: r.count,
    maxHits: rule.maxHits,
    windowMs: rule.windowMs,
    retryAfterMs: r.retryAfterMs,
    pattern: rule.pattern,
  };
}

module.exports = {
  enabled,
  set,
  get,
  remove,
  list,
  match,
  check,
  TABLE,
};
