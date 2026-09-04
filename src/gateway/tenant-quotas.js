'use strict';
// FS-Z6 — tenant quota enforcement.
// Per-tenant quotas for API calls, storage, and skills.
// Checks quota before allowing operations; returns 429 when exceeded.
// Inert when TG_TENANT_QUOTAS unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_TENANT_QUOTAS === '1';
}

function _ensureTables() {
  // Use Z6-prefixed tables to avoid collision with other modules' tenant_quotas
  db.exec(`
    CREATE TABLE IF NOT EXISTS z6_tenant_quotas (
      tenant      TEXT NOT NULL,
      resource    TEXT NOT NULL,
      max_value   INTEGER NOT NULL,
      PRIMARY KEY (tenant, resource)
    );
    CREATE TABLE IF NOT EXISTS z6_tenant_usage (
      tenant      TEXT NOT NULL,
      resource    TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      PRIMARY KEY (tenant, resource)
    );
  `);
}

function setQuota(tenant, resource, maxValue) {
  if (!enabled()) return null;
  _ensureTables();
  db.prepare(
    'INSERT OR REPLACE INTO z6_tenant_quotas(tenant, resource, max_value) VALUES(?, ?, ?)'
  ).run(tenant, resource, Number(maxValue));
  return { tenant, resource, maxValue: Number(maxValue) };
}

function getQuota(tenant, resource) {
  if (!enabled()) return null;
  _ensureTables();
  const row = db.prepare(
    'SELECT max_value FROM z6_tenant_quotas WHERE tenant = ? AND resource = ?'
  ).get(tenant, resource);
  return row ? { tenant, resource, maxValue: row.max_value } : null;
}

function checkAndIncrement(tenant, resource, amount) {
  if (!enabled()) return { allowed: true, quotaDisabled: true };
  _ensureTables();
  const quota = db.prepare(
    'SELECT max_value FROM z6_tenant_quotas WHERE tenant = ? AND resource = ?'
  ).get(tenant, resource);
  if (!quota) return { allowed: true, noQuotaSet: true };
  const now = Date.now();
  const windowMs = Number(process.env.TG_QUOTA_WINDOW_MS) || 3600000;
  const usage = db.prepare(
    'SELECT used, window_start FROM z6_tenant_usage WHERE tenant = ? AND resource = ?'
  ).get(tenant, resource);
  let currentUsed = 0;
  if (usage && (now - usage.window_start) < windowMs) {
    currentUsed = usage.used;
  }
  const newUsed = currentUsed + (amount || 1);
  if (newUsed > quota.max_value) {
    return { allowed: false, tenant, resource, used: currentUsed, max: quota.max_value, requested: amount || 1 };
  }
  db.prepare(
    'INSERT OR REPLACE INTO z6_tenant_usage(tenant, resource, used, window_start) VALUES(?, ?, ?, ?)'
  ).run(tenant, resource, newUsed, usage && (now - usage.window_start) < windowMs ? usage.window_start : now);
  return { allowed: true, tenant, resource, used: newUsed, max: quota.max_value };
}

function getUsage(tenant, resource) {
  if (!enabled()) return null;
  _ensureTables();
  const usage = db.prepare(
    'SELECT used, window_start FROM z6_tenant_usage WHERE tenant = ? AND resource = ?'
  ).get(tenant, resource);
  if (!usage) return { tenant, resource, used: 0, windowStart: null };
  return { tenant, resource, used: usage.used, windowStart: usage.window_start };
}

module.exports = { enabled, setQuota, getQuota, checkAndIncrement, getUsage };
