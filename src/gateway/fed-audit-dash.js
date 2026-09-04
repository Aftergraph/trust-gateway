'use strict';
// FS-Z2 — federation audit dashboard.
// Aggregates audit_chain events across all tenants for operator visibility.
// Supports filtering by type, tenant, time range. Returns paginated results.
// Inert when TG_FED_AUDIT_DASH unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_FED_AUDIT_DASH === '1';
}

function _parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return {}; }
}

function query(opts) {
  if (!enabled()) return null;
  const { type, tenant, since, until, limit, offset } = opts || {};
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;
  const tsSince = since ? Number(since) : 0;
  const tsUntil = until ? Number(until) : Date.now() + 86400000;
  const rows = db.prepare(
    'SELECT seq, payload, ts FROM chain_entries WHERE ts >= ? AND ts <= ? ORDER BY seq DESC'
  ).all(tsSince, tsUntil);
  let filtered = rows.map(r => ({ ...r, parsed: _parsePayload(r.payload) }));
  if (type) filtered = filtered.filter(r => r.parsed.type === type);
  if (tenant) filtered = filtered.filter(r => r.parsed.tenant === tenant);
  const total = filtered.length;
  const paged = filtered.slice(off, off + lim);
  return {
    total,
    limit: lim,
    offset: off,
    events: paged.map(r => ({
      id: r.seq,
      tenant: r.parsed.tenant,
      type: r.parsed.type,
      data: r.parsed.data || r.parsed,
      ts: r.ts,
    })),
  };
}

function summary(windowMs) {
  if (!enabled()) return null;
  const now = Date.now();
  const since = now - (windowMs || 3600000);
  const rows = db.prepare(
    'SELECT payload FROM chain_entries WHERE ts >= ? ORDER BY seq'
  ).all(since);
  const byTypeMap = {};
  const byTenantMap = {};
  for (const r of rows) {
    const p = _parsePayload(r.payload);
    const t = p.type || 'unknown';
    byTypeMap[t] = (byTypeMap[t] || 0) + 1;
    if (p.tenant) {
      byTenantMap[p.tenant] = (byTenantMap[p.tenant] || 0) + 1;
    }
  }
  const total = rows.length;
  return {
    windowMs: windowMs || 3600000,
    since,
    now,
    totalEvents: total,
    byType: Object.entries(byTypeMap).map(([type, count]) => ({ type, count })).sort((a,b) => b.count - a.count),
    byTenant: Object.entries(byTenantMap).map(([tenant, count]) => ({ tenant, count })).sort((a,b) => b.count - a.count),
  };
}

module.exports = { enabled, query, summary };
