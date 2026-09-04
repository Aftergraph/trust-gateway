'use strict';
// FS-Z2 — federation audit dashboard.
// Aggregates audit_chain events across all tenants for operator visibility.
// Supports filtering by type, tenant, time range. Returns paginated results.
// Inert when TG_FED_AUDIT_DASH unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_FED_AUDIT_DASH === '1';
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

function query(opts) {
  if (!enabled()) return null;
  _ensureTable();
  const { type, tenant, since, until, limit, offset } = opts || {};
  const conditions = [];
  const params = [];
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (tenant) { conditions.push('tenant = ?'); params.push(tenant); }
  if (since) { conditions.push('ts >= ?'); params.push(Number(since)); }
  if (until) { conditions.push('ts <= ?'); params.push(Number(until)); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;
  const rows = db.prepare(
    `SELECT id, tenant, type, data, ts FROM audit_chain ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, lim, off);
  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM audit_chain ${where}`
  ).get(...params);
  return {
    total: Number(countRow.cnt),
    limit: lim,
    offset: off,
    events: rows.map(r => ({
      id: r.id,
      tenant: r.tenant,
      type: r.type,
      data: (() => { try { return JSON.parse(r.data); } catch { return r.data; } })(),
      ts: r.ts,
    })),
  };
}

function summary(windowMs) {
  if (!enabled()) return null;
  _ensureTable();
  const now = Date.now();
  const since = now - (windowMs || 3600000);
  const byType = db.prepare(
    'SELECT type, COUNT(*) as cnt FROM audit_chain WHERE ts >= ? GROUP BY type ORDER BY cnt DESC'
  ).all(since);
  const byTenant = db.prepare(
    'SELECT tenant, COUNT(*) as cnt FROM audit_chain WHERE ts >= ? AND tenant IS NOT NULL GROUP BY tenant ORDER BY cnt DESC'
  ).all(since);
  const total = byType.reduce((s, r) => s + Number(r.cnt), 0);
  return {
    windowMs: windowMs || 3600000,
    since,
    now,
    totalEvents: total,
    byType: byType.map(r => ({ type: r.type, count: Number(r.cnt) })),
    byTenant: byTenant.map(r => ({ tenant: r.tenant, count: Number(r.cnt) })),
  };
}

module.exports = { enabled, query, summary };
