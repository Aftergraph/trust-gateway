'use strict';
// FS-W1 — tenant activity tracking.
// Records last_activity_at + total_ops per tenant. Used for "ghost tenant"
// detection (inactive tenants visible in /v2/tenants/inactive).
// Inert when TG_TENANT_ACTIVITY unset (returns 0/null).

const { db, tx } = require('./db');

const TABLE = 'tenant_activity';

function enabled() {
  return process.env.TG_TENANT_ACTIVITY === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      tenant          TEXT PRIMARY KEY,
      last_activity_at INTEGER NOT NULL,
      total_ops       INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function touch(tenant) {
  if (!enabled() || !tenant) return 0;
  _ensureTable();
  const at = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(tenant, last_activity_at, total_ops)
       VALUES(?, ?, 1)
       ON CONFLICT(tenant) DO UPDATE SET
         last_activity_at = excluded.last_activity_at,
         total_ops = total_ops + 1`
    ).run(tenant, at);
  });
  return at;
}

function getActivity(tenant) {
  if (!enabled() || !tenant) return null;
  _ensureTable();
  let r;
  try {
    r = db.prepare(`SELECT tenant, last_activity_at, total_ops FROM ${TABLE} WHERE tenant = ?`).get(tenant);
  } catch { return null; }
  if (!r) return null;
  return { tenant: r.tenant, lastActivityAt: r.last_activity_at, totalOps: r.total_ops };
}

function listInactive(thresholdMs, now) {
  if (!enabled()) return [];
  _ensureTable();
  const at = Number.isFinite(now) ? now : Date.now();
  const thresh = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : 30 * 24 * 60 * 60 * 1000;
  const cutoff = at - thresh;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT tenant, last_activity_at, total_ops FROM ${TABLE} WHERE last_activity_at < ? ORDER BY last_activity_at ASC`
    ).all(cutoff);
  } catch { return []; }
  return rows.map(r => ({
    tenant: r.tenant,
    lastActivityAt: r.last_activity_at,
    totalOps: r.total_ops,
    ageMs: at - r.last_activity_at,
  }));
}

module.exports = {
  enabled,
  touch,
  getActivity,
  listInactive,
  TABLE,
};
