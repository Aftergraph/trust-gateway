'use strict';
// FS-N1 — tenant-scoped feature flag overrides.
//
// Extends the global feature_flags table with per-tenant overrides.
// get(name, tenant?) returns: tenant override > global db > env > null.
// set(name, opts, by, tenant?) writes to the right scope.
//
// Schema: feature_flags(name, enabled, value, updated_at, updated_by, tenant)
//   - tenant=NULL rows are GLOBAL
//   - tenant='acme' rows override the global for that tenant
//
// Inert (no per-tenant logic) when TG_TENANT_FLAGS unset.

const { db, tx } = require('./db');

function enabled() {
  return process.env.TG_TENANT_FLAGS === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      tenant      TEXT,
      name        TEXT NOT NULL,
      enabled     INTEGER,
      value       TEXT,
      updated_at  INTEGER NOT NULL,
      updated_by  TEXT,
      PRIMARY KEY (tenant, name)
    );
  `);
}

function _coerce(v) {
  if (v === null || v === undefined) return null;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  const n = Number(v);
  if (Number.isFinite(n) && String(n) === String(v)) return n;
  return v;
}

function _envDefault(name) {
  const enabled = process.env[`TG_FEATURE_${name.toUpperCase()}_ENABLED`];
  const value = process.env[`TG_FEATURE_${name.toUpperCase()}_VALUE`];
  if (enabled === undefined && value === undefined) return null;
  return {
    enabled: enabled === '1' || enabled === 'true' ? true : enabled === '0' || enabled === 'false' ? false : null,
    value: value === undefined ? null : _coerce(value),
    source: 'env',
  };
}

function _row(r) {
  if (!r) return null;
  return {
    tenant: r.tenant,
    name: r.name,
    enabled: r.enabled === null ? null : r.enabled === 1,
    value: r.value === null ? null : _coerce(r.value),
    source: r.tenant ? 'tenant' : 'global',
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function get(name, tenant) {
  _ensureTable();
  // 1. Tenant override
  if (tenant) {
    const r = db.prepare(
      `SELECT * FROM feature_flags WHERE tenant = ? AND name = ?`
    ).get(tenant, name);
    if (r) return _row(r);
  }
  // 2. Global
  const g = db.prepare(`SELECT * FROM feature_flags WHERE tenant IS NULL AND name = ?`).get(name);
  if (g) return _row(g);
  // 3. Env
  return _envDefault(name);
}

function set(name, { enabled, value }, by, tenant) {
  _ensureTable();
  const at = Date.now();
  const t = tenant || null;
  tx(() => {
    db.prepare(
      `INSERT INTO feature_flags(tenant, name, enabled, value, updated_at, updated_by)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant, name) DO UPDATE SET
         enabled = excluded.enabled,
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).run(t, name, enabled === null ? null : (enabled ? 1 : 0), value === null || value === undefined ? null : String(value), at, by || 'unknown');
  });
  return { tenant, name, enabled, value, updatedAt: at, source: tenant ? 'tenant' : 'global', updatedBy: by };
}

function reset(name, tenant) {
  _ensureTable();
  let info;
  if (tenant) {
    info = db.prepare(`DELETE FROM feature_flags WHERE name = ? AND tenant = ?`).run(name, tenant);
  } else {
    info = db.prepare(`DELETE FROM feature_flags WHERE name = ? AND tenant IS NULL`).run(name);
  }
  return Number(info.changes || 0) > 0;
}

function listForTenant(tenant) {
  if (!enabled() || !tenant) return [];
  _ensureTable();
  const rows = db.prepare(
    `SELECT * FROM feature_flags WHERE tenant = ? OR tenant IS NULL ORDER BY tenant NULLS FIRST, name`
  ).all(tenant);
  return rows.map(_row);
}

module.exports = {
  enabled,
  get,
  set,
  reset,
  listForTenant,
};
