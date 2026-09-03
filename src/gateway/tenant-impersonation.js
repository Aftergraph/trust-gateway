'use strict';
// FS-O2 — tenant impersonation (operator support-context).
//
// issueImpersonation(operatorName, targetTenant, ttlMs) → {token, expiresAt}.
// The token, when presented as Bearer auth, is treated as a synthetic bot
// whose name is 'impersonate:<operator>:<tenant>'. All operations under
// this token are scoped to the target tenant AND auditable with the
// real operator name.
//
// Security: tokens are 32-byte random hex; the lookup table is in SQLite
// so revocations and lookups survive restart. Inert (returns null) when
// TG_TENANT_IMPERSONATION unset.

const { db, tx } = require('./db');
const crypto = require('node:crypto');

const TABLE = 'impersonation_tokens';

function enabled() {
  return process.env.TG_TENANT_IMPERSONATION === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      token         TEXT PRIMARY KEY,
      operator_name TEXT NOT NULL,
      target_tenant TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      revoked_at    INTEGER,
      reason        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_expires ON ${TABLE}(expires_at);
  `);
}

function _now() { return Date.now(); }

function issue(operatorName, targetTenant, ttlMs, reason) {
  if (!enabled()) return null;
  if (!operatorName || !targetTenant) return null;
  const at = _now();
  const exp = at + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 15 * 60 * 1000); // default 15 min
  const token = crypto.randomBytes(32).toString('hex');
  _ensureTable();
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(token, operator_name, target_tenant, created_at, expires_at, reason)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run(token, operatorName, targetTenant, at, exp, reason || null);
  });
  return { token, expiresAt: exp, targetTenant, operator: operatorName, ttlMs: exp - at };
}

function resolve(token) {
  if (!enabled() || !token) return null;
  _ensureTable();
  const r = db.prepare(
    `SELECT operator_name, target_tenant, expires_at, revoked_at FROM ${TABLE} WHERE token = ?`
  ).get(token);
  if (!r) return null;
  if (r.revoked_at) return null;
  if (r.expires_at < _now()) return null;
  return { operator: r.operator_name, tenant: r.target_tenant, expiresAt: r.expires_at };
}

function revoke(token, reason) {
  if (!enabled()) return false;
  _ensureTable();
  const info = db.prepare(
    `UPDATE ${TABLE} SET revoked_at = ?, reason = COALESCE(?, reason) WHERE token = ? AND revoked_at IS NULL`
  ).run(_now(), reason || null, token);
  return Number(info.changes || 0) > 0;
}

function listActive() {
  if (!enabled()) return [];
  _ensureTable();
  return db.prepare(
    `SELECT token, operator_name, target_tenant, created_at, expires_at, reason
     FROM ${TABLE} WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
  ).all(_now());
}

function cleanupExpired() {
  if (!enabled()) return 0;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE expires_at < ?`).run(_now() - 24 * 60 * 60 * 1000);
  return Number(info.changes || 0);
}

module.exports = { enabled, issue, resolve, revoke, listActive, cleanupExpired, TABLE };
