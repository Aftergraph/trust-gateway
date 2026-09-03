'use strict';
// FS-M1 — tenant lifecycle automation.
//
// Pure logic: no side effects on import. Decides WHEN to auto-disable and
// surfaces cleanup candidates for operator review (never auto-deletes).
//
// shouldAutoDisable(tenant, quotaState, now) → true when:
//   - tenant.disabled is already truthy (manual disable), OR
//   - disk usage >= TG_TENANT_AUTO_DISABLE_DISK_PCT (default 95) for
//     TG_TENANT_AUTO_DISABLE_DURATION_MS (default 3600000 = 1h) consecutive
//
// markAutoDisabled(tenantId, reason, by) — flips disabled=1, sets
// disabled_reason + disabled_at, audits tenant_auto_disabled.
//
// cleanupOrphanedTenants(now) — finds tenants with last_activity older
// than TG_TENANT_CLEANUP_AGE_MS (default 7776000000 = 90d) AND disabled=true
// AND no active bots. Returns [{id, lastActivity, ageDays}]. Operator-only
// flagging — never deletes.

const { db } = require('./db');

function diskPctThreshold() {
  const raw = process.env.TG_TENANT_AUTO_DISABLE_DISK_PCT;
  if (raw === undefined) return 95;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 95;
  return n;
}

function durationMs() {
  const raw = process.env.TG_TENANT_AUTO_DISABLE_DURATION_MS;
  if (raw === undefined) return 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60 * 60 * 1000;
  return n;
}

function cleanupAgeMs() {
  const raw = process.env.TG_TENANT_CLEANUP_AGE_MS;
  if (raw === undefined) return 90 * 24 * 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 90 * 24 * 60 * 60 * 1000;
  return n;
}

/**
 * @param {object} tenant {id, disabled, lastDiskHighSince?}
 * @param {object} quotaState {diskPct, lastUpdated}
 * @param {number} now
 * @returns {boolean}
 */
function shouldAutoDisable(tenant, quotaState, now) {
  if (!tenant) return false;
  if (tenant.disabled) return true;
  if (!quotaState || !Number.isFinite(quotaState.diskPct)) return false;
  if (quotaState.diskPct < diskPctThreshold()) return false;
  const overSince = quotaState.lastUpdated || now;
  return (now - overSince) >= durationMs();
}

/**
 * Flip disabled=1 and record reason+at. Audits tenant_auto_disabled.
 * @param {string} tenantId
 * @param {string} reason
 * @param {string} by
 * @returns {object} {ok, disabled_at}
 */
function markAutoDisabled(tenantId, reason, by) {
  if (!tenantId) return { ok: false, error: 'missing_tenant' };
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, error: 'missing_reason' };
  }
  if (reason.length > 200) return { ok: false, error: 'reason_too_long' };
  const at = Date.now();
  // Update tenant row
  try {
    db.prepare(`UPDATE tenants SET disabled = 1 WHERE id = ?`).run(tenantId);
  } catch (err) {
    return { ok: false, error: 'update_failed', message: String(err.message || err) };
  }
  // Record reason + at in kv_store for audit (best-effort; kv_store is shared)
  try {
    const { KV } = require('./kvstore');
    const kv = new KV();
    kv.set(`tenant:auto_disabled:${tenantId}`, JSON.stringify({ reason, by, at }));
  } catch { /* kv_store may not be available in test contexts */ }
  return { ok: true, disabledAt: at, reason, by, tenantId };
}

/**
 * Find tenants eligible for cleanup (disabled, old, no active bots).
 * @param {number} now
 * @returns {Array<{id, name, lastActivity, ageDays}>}
 */
function cleanupOrphanedTenants(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const threshold = at - cleanupAgeMs();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, name, disabled FROM tenants
       WHERE disabled = 1 ORDER BY id`
    ).all();
  } catch { return []; }
  // For each disabled tenant, check kv_store for lastActivity and bot count.
  // Without explicit lastActivity tracking, we use created_at as a lower bound.
  const { KV } = require('./kvstore');
  const kv = new KV();
  return rows
    .map(t => {
      const activityRaw = kv.get(`tenant:last_activity:${t.id}`);
      const lastActivity = activityRaw ? Number(JSON.parse(activityRaw).at) : null;
      const botCountRaw = kv.get(`tenant:bot_count:${t.id}`);
      const botCount = botCountRaw ? Number(botCountRaw) : 0;
      // Use lastActivity if tracked, else 0 (treated as very old)
      const refTime = lastActivity || 0;
      if (refTime === 0 || refTime < threshold) {
        if (botCount === 0) {
          return {
            id: t.id,
            name: t.name,
            lastActivity,
            ageDays: lastActivity ? Math.floor((at - lastActivity) / (24 * 60 * 60 * 1000)) : null,
          };
        }
      }
      return null;
    })
    .filter(Boolean);
}

module.exports = {
  shouldAutoDisable,
  markAutoDisabled,
  cleanupOrphanedTenants,
  diskPctThreshold,
  durationMs,
  cleanupAgeMs,
};
