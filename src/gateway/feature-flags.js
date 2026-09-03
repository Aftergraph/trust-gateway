'use strict';
// FS-L3 — persistent feature flags.
//
// Env-defaulted, runtime-overridable via operator. On read: env defaults
// first, then any DB row for the same flag wins. Reset = delete DB row
// → reverts to env. Hot-reload picks up DB changes on SIGHUP.
//
// Env conventions:
//   TG_FEATURE_<NAME>_ENABLED  → '1'|'0'|true|false (boolean)
//   TG_FEATURE_<NAME>_VALUE    → any string (coerced to number/bool when possible)
//
// Inert when no flags are registered (no env, no rows) — empty list().

const { db, tx } = require('./db');

const TABLE = 'feature_flags';

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      name        TEXT PRIMARY KEY,
      enabled     INTEGER,
      value       TEXT,
      updated_at  INTEGER NOT NULL,
      updated_by  TEXT
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

function get(name) {
  _ensureTable();
  const r = db.prepare(`SELECT name, enabled, value, updated_at, updated_by FROM ${TABLE} WHERE name = ?`).get(name);
  if (r) {
    return {
      name: r.name,
      enabled: r.enabled === null ? null : r.enabled === 1,
      value: r.value === null ? null : _coerce(r.value),
      source: 'db',
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  }
  return _envDefault(name);
}

function set(name, { enabled, value }, by) {
  _ensureTable();
  const at = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(name, enabled, value, updated_at, updated_by)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         enabled = excluded.enabled,
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).run(name, enabled === null ? null : (enabled ? 1 : 0), value === null || value === undefined ? null : String(value), at, by || 'unknown');
  });
  return { name, enabled, value, source: 'db', updatedAt: at, updatedBy: by };
}

function reset(name) {
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE name = ?`).run(name);
  return Number(info.changes || 0) > 0;
}

function list() {
  _ensureTable();
  const dbRows = db.prepare(`SELECT name, enabled, value, updated_at, updated_by FROM ${TABLE} ORDER BY name`)
    .all()
    .map(r => ({
      name: r.name,
      enabled: r.enabled === null ? null : r.enabled === 1,
      value: r.value === null ? null : _coerce(r.value),
      source: 'db',
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  // Include env-only flags not in DB
  const envNames = Object.keys(process.env)
    .filter(k => k.startsWith('TG_FEATURE_') && k.endsWith('_ENABLED'))
    .map(k => k.slice('TG_FEATURE_'.length, -'_ENABLED'.length));
  const dbNames = new Set(dbRows.map(r => r.name));
  const envOnly = envNames
    .filter(n => !dbNames.has(n))
    .map(n => {
      const env = _envDefault(n);
      return env ? { name: n, enabled: env.enabled, value: env.value, source: 'env' } : null;
    })
    .filter(Boolean);
  return [...dbRows, ...envOnly];
}

module.exports = {
  get,
  set,
  reset,
  list,
  TABLE,
};
