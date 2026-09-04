'use strict';
// FS-Y1 — per-tenant webhook subscriptions (extends FS-L2 with tenant scope).
// Same backpressure semantics as L2 (3s timeout, 1/60s per-url rate limit,
// 3-failures/60s → 5min backoff per url). Tenant='*' subscribes to events
// for all tenants.
//
// Inert (returns null/[]) when TG_WEBHOOK_SUBS_TENANT unset.

const { db, tx } = require('./db');

const TABLE = 'webhook_subs_tenant';

function enabled() {
  return process.env.TG_WEBHOOK_SUBS_TENANT === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant            TEXT NOT NULL,
      url               TEXT NOT NULL,
      event_types       TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      created_by        TEXT NOT NULL,
      last_delivered_at INTEGER,
      last_error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant);
  `);
}

function create(tenant, url, eventTypes, by) {
  if (!enabled()) return null;
  if (!tenant || !url || typeof url !== 'string' || !url.startsWith('http')) {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    throw Object.assign(new Error('invalid_event_types'), { code: 'invalid_event_types' });
  }
  _ensureTable();
  const at = Date.now();
  return tx(() => {
    const info = db.prepare(
      `INSERT INTO ${TABLE}(tenant, url, event_types, created_at, created_by)
       VALUES(?, ?, ?, ?, ?)`
    ).run(tenant, url, JSON.stringify(eventTypes), at, by || 'unknown');
    return { id: Number(info.lastInsertRowid), tenant, url, eventTypes, createdAt: at, createdBy: by };
  });
}

function listForTenant(tenant) {
  if (!enabled() || !tenant) return [];
  _ensureTable();
  return db.prepare(
    `SELECT id, tenant, url, event_types, created_at, created_by, last_delivered_at, last_error
     FROM ${TABLE} WHERE tenant = ? OR tenant = '*' ORDER BY id`
  ).all(tenant)
    .map(_row);
}

function listAll() {
  if (!enabled()) return [];
  _ensureTable();
  return db.prepare(
    `SELECT id, tenant, url, event_types, created_at, created_by, last_delivered_at, last_error
     FROM ${TABLE} ORDER BY tenant, id`
  ).all().map(_row);
}

function remove(tenant, id) {
  if (!enabled() || !tenant || !id) return false;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE id = ? AND tenant = ?`).run(id, tenant);
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
    tenant: r.tenant,
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
  listForTenant,
  listAll,
  remove,
  recordDelivery,
  TABLE,
};
