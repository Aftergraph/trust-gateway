'use strict';
// FS-K4 — quota usage auto-alerts.
//
// On each snapshot, evaluate disk and API quotas against thresholds
// (env-configurable, defaults 80%). Uses AlertSink from FS-G3 (rate-limited
// 1/60s per type, suppressed after 5/hour globally). Per-tenant dedup
// tracked in kv_store so one tenant can't spam alerts.
//
// Env: TG_QUOTA_DISK_WARN_PCT (default 80), TG_QUOTA_API_WARN_PCT (default 80).
// Inert when AlertSink is inert (no TG_ALERT_URLS).

const { db } = require('./db');
const { KV } = require('./kvstore');

function diskWarnPct() {
  const raw = process.env.TG_QUOTA_DISK_WARN_PCT;
  if (raw === undefined) return 80;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 80;
  return n;
}

function apiWarnPct() {
  const raw = process.env.TG_QUOTA_API_WARN_PCT;
  if (raw === undefined) return 80;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 80;
  return n;
}

const kv = new KV();

/**
 * Check both quotas for one tenant. Returns {disk: {...}|null, api: {...}|null}.
 * Pure: no side effects, no AlertSink calls (caller wires that).
 */
function evaluateTenant(tenant, usedMb, limitMb, apiCount, apiLimit) {
  if (!tenant) return { disk: null, api: null };
  const result = { disk: null, api: null };

  if (Number.isFinite(usedMb) && Number.isFinite(limitMb) && limitMb > 0) {
    const pct = Math.floor((usedMb / limitMb) * 100);
    if (pct >= diskWarnPct()) {
      result.disk = { tenant, usedMb, limitMb, pct };
    }
  }

  if (Number.isFinite(apiCount) && Number.isFinite(apiLimit) && apiLimit > 0) {
    const pct = Math.floor((apiCount / apiLimit) * 100);
    if (pct >= apiWarnPct()) {
      result.api = { tenant, apiCount, limit: apiLimit, pct };
    }
  }

  return result;
}

/** Per-tenant dedup: one alert per type per hour per tenant. */
function shouldEmit(tenant, type, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const hourBucket = Math.floor(at / (60 * 60 * 1000));
  const key = `quotaAlert:warn:${type}:${tenant}:${hourBucket}`;
  if (kv.get(key)) return false;
  kv.set(key, at);
  return true;
}

/** Process a tenant's quota state and return alerts to emit. */
function checkTenant(tenant, usedMb, limitMb, apiCount, apiLimit, now) {
  const evalResult = evaluateTenant(tenant, usedMb, limitMb, apiCount, apiLimit);
  const alerts = [];
  if (evalResult.disk && shouldEmit(tenant, 'quota_disk_warning', now)) {
    alerts.push({ type: 'quota_disk_warning', payload: evalResult.disk });
  }
  if (evalResult.api && shouldEmit(tenant, 'quota_api_warning', now)) {
    alerts.push({ type: 'quota_api_warning', payload: evalResult.api });
  }
  return alerts;
}

/** Recent alert history for a tenant (read from chain audit). */
function recentAlerts(tenant, limit = 100) {
  if (!tenant) return [];
  const lim = Math.max(1, Math.min(limit, 100));
  const since = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const rows = db.prepare(
      `SELECT seq, ts, type, payload FROM audit_chain
       WHERE type IN ('quota_disk_warning', 'quota_api_warning')
         AND ts >= ?
         AND json_extract(payload, '$.tenant') = ?
       ORDER BY ts DESC LIMIT ?`
    ).all(since, tenant, lim);
    return rows.map(r => ({
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      payload: (() => { try { return JSON.parse(r.payload); } catch { return null; } })(),
    }));
  } catch {
    // audit_chain table may not exist in test contexts
    return [];
  }
}

module.exports = {
  evaluateTenant,
  shouldEmit,
  checkTenant,
  recentAlerts,
  diskWarnPct,
  apiWarnPct,
};
