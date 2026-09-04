'use strict';
// FS-Z1 — tenant metrics aggregates.
// Aggregates audit_chain events per tenant over sliding windows.
// Returns counts by event type, last activity, and trend data.
// Inert when TG_TENANT_METRICS unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_TENANT_METRICS === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_chain (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant    TEXT,
      type      TEXT NOT NULL,
      data      TEXT,
      prev_hash TEXT,
      ts        INTEGER NOT NULL,
      hash      TEXT NOT NULL
    )
  `);
}

function getMetrics(tenant, windowMs) {
  if (!enabled() || !tenant) return null;
  _ensureTable();
  const now = Date.now();
  const since = now - (windowMs || 3600000); // default 1h
  const rows = db.prepare(
    `SELECT type, COUNT(*) as cnt FROM audit_chain
     WHERE tenant = ? AND ts >= ? GROUP BY type ORDER BY cnt DESC`
  ).all(tenant, since);
  const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
  const lastRow = db.prepare(
    'SELECT ts FROM audit_chain WHERE tenant = ? ORDER BY ts DESC LIMIT 1'
  ).get(tenant);
  return {
    tenant,
    windowMs: windowMs || 3600000,
    since,
    now,
    totalEvents: total,
    byType: rows.map(r => ({ type: r.type, count: Number(r.cnt) })),
    lastActivityAt: lastRow ? lastRow.ts : null,
  };
}

function getAllTenantsSummary(windowMs) {
  if (!enabled()) return null;
  _ensureTable();
  const now = Date.now();
  const since = now - (windowMs || 3600000);
  const rows = db.prepare(
    `SELECT tenant, COUNT(*) as cnt FROM audit_chain
     WHERE ts >= ? AND tenant IS NOT NULL GROUP BY tenant ORDER BY cnt DESC`
  ).all(since);
  return {
    windowMs: windowMs || 3600000,
    since,
    now,
    tenantCount: rows.length,
    tenants: rows.map(r => ({ tenant: r.tenant, events: Number(r.cnt) })),
  };
}

module.exports = { enabled, getMetrics, getAllTenantsSummary };
