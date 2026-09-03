'use strict';
// FS-L2 — webhook subscription management.
//
// Operator-managed multi-sink delivery: when TG_WEBHOOK_SUBS=1, every
// audit event is also fanned out to each registered subscription whose
// eventTypes includes the event type. Same backpressure semantics as
// FS-G3 audit-export WebhookSink: 3s timeout, 1/60s per-url rate limit,
// 3-failures/60s → 5min backoff per url.
//
// Inert (no table, no delivery) when TG_WEBHOOK_SUBS unset — byte-identical
// legacy.

const { db, tx } = require('./db');

const TABLE = 'webhook_subs';

function enabled() {
  return process.env.TG_WEBHOOK_SUBS === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      url               TEXT NOT NULL,
      event_types       TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      created_by        TEXT NOT NULL,
      last_delivered_at INTEGER,
      last_error        TEXT
    );
  `);
}

function create({ url, eventTypes, by }) {
  if (!enabled()) return null;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    throw Object.assign(new Error('invalid_url'), { code: 'invalid_url' });
  }
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    throw Object.assign(new Error('invalid_event_types'), { code: 'invalid_event_types' });
  }
  _ensureTable();
  const at = Date.now();
  return tx(() => {
    const info = db.prepare(
      `INSERT INTO ${TABLE}(url, event_types, created_at, created_by) VALUES(?, ?, ?, ?)`
    ).run(url, JSON.stringify(eventTypes), at, by || 'unknown');
    return { id: Number(info.lastInsertRowid), url, eventTypes, createdAt: at, createdBy: by };
  });
}

function list() {
  if (!enabled()) return [];
  _ensureTable();
  return db.prepare(`SELECT id, url, event_types, created_at, created_by, last_delivered_at, last_error FROM ${TABLE} ORDER BY id`)
    .all()
    .map(_row);
}

function get(id) {
  if (!enabled()) return null;
  _ensureTable();
  const r = db.prepare(`SELECT id, url, event_types, created_at, created_by, last_delivered_at, last_error FROM ${TABLE} WHERE id = ?`)
    .get(id);
  return _row(r);
}

function remove(id) {
  if (!enabled()) return false;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
  return Number(info.changes || 0) > 0;
}

function recordDelivery(id, ok, error) {
  if (!enabled()) return;
  _ensureTable();
  const at = Date.now();
  db.prepare(
    `UPDATE ${TABLE} SET last_delivered_at = ?, last_error = ? WHERE id = ?`
  ).run(at, error ? String(error).slice(0, 200) : null, id);
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    url: r.url,
    eventTypes: (() => { try { return JSON.parse(r.event_types); } catch { return []; } })(),
    createdAt: r.created_at,
    createdBy: r.created_by,
    lastDeliveredAt: r.last_delivered_at,
    lastError: r.last_error,
  };
}

module.exports = {
  enabled,
  create,
  list,
  get,
  remove,
  recordDelivery,
  TABLE,
};
