'use strict';
// FS-Z1 — tenant metrics aggregates.
// Aggregates audit_chain events per tenant over sliding windows.
// Returns counts by event type, last activity, and trend data.
// Inert when TG_TENANT_METRICS unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_TENANT_METRICS === '1';
}

function _parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return {}; }
}

function getMetrics(tenant, windowMs) {
  if (!enabled() || !tenant) return null;
  // Anti-enumeration: unknown or disabled tenant → null (mount serves 404).
  // Read the store via db directly — getTenantStore() requires a gw instance
  // which module-level helpers don't have.
  try {
    const row = db.prepare('SELECT disabled FROM tenants WHERE id = ?').get(tenant);
    if (!row || row.disabled) return null;
  } catch { /* tenant table missing — proceed with metrics-only view */ }
  const now = Date.now();
  const since = now - (windowMs || 3600000); // default 1h
  const rows = db.prepare(
    'SELECT payload, ts FROM chain_entries WHERE ts >= ? ORDER BY seq'
  ).all(since);
  const filtered = rows.filter(r => {
    const p = _parsePayload(r.payload);
    return p.tenant === tenant;
  });
  const byTypeMap = {};
  for (const r of filtered) {
    const p = _parsePayload(r.payload);
    const t = p.type || 'unknown';
    byTypeMap[t] = (byTypeMap[t] || 0) + 1;
  }
  const total = filtered.length;
  const lastTs = filtered.length > 0 ? filtered[filtered.length - 1].ts : null;
  return {
    tenant,
    windowMs: windowMs || 3600000,
    since,
    now,
    totalEvents: total,
    byType: Object.entries(byTypeMap).map(([type, count]) => ({ type, count })),
    lastActivityAt: lastTs,
  };
}

function getAllTenantsSummary(windowMs) {
  if (!enabled()) return null;
  const now = Date.now();
  const since = now - (windowMs || 3600000);
  const rows = db.prepare(
    'SELECT payload FROM chain_entries WHERE ts >= ? ORDER BY seq'
  ).all(since);
  const tenantMap = {};
  for (const r of rows) {
    const p = _parsePayload(r.payload);
    if (p.tenant) {
      tenantMap[p.tenant] = (tenantMap[p.tenant] || 0) + 1;
    }
  }
  return {
    windowMs: windowMs || 3600000,
    since,
    now,
    tenantCount: Object.keys(tenantMap).length,
    tenants: Object.entries(tenantMap).map(([tenant, events]) => ({ tenant, events })),
  };
}

module.exports = { enabled, getMetrics, getAllTenantsSummary };
