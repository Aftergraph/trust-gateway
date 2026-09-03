'use strict';
// FS-K2 — tenant-scoped telemetry isolation.
//
// getTenantEvents(tenant, filters) returns a payloadSummary-projected
// view of audit events for a single tenant. NEVER returns raw payload —
// only type-specific scalar projections. Falls back to {type:'restricted'}
// for unknown event types.
//
// Inert (404) when TG_TELEMETRY_TENANT_SCOPED unset — byte-identical legacy.

const { db } = require('./db');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const KNOWN_TYPES = new Set([
  'skill_executed', 'skill_published', 'skill_unpublished',
  'skill_federated', 'skill_unfederated', 'skill_fed_limited',
  'skill_fed_real_requested', 'skill_fed_real_approved_owner',
  'skill_fed_real_approved_runner', 'skill_fed_real_executed',
  'skill_fed_real_denied',
  'approval', 'run', 'quota', 'quota_exceeded', 'quota_disk_warning',
  'quota_api_warning', 'tenant_quota_exceeded',
  'palette_command', 'observability_read', 'observability_denied',
  'federation_audit_read', 'federation_audit_denied',
]);

function enabled() {
  return process.env.TG_TELEMETRY_TENANT_SCOPED === '1';
}

/** Project one event row to a safe summary. */
function _summary(type, payload) {
  if (!KNOWN_TYPES.has(type)) return { type: 'restricted' };
  let p = payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { p = {}; }
  }
  p = p || {};

  switch (type) {
    case 'skill_executed':
      return { skillId: p.skillId, status: p.status, completed: p.completed };
    case 'skill_published':
    case 'skill_unpublished':
    case 'skill_federated':
    case 'skill_unfederated':
      return { id: p.id };
    case 'skill_fed_limited':
      return { runnerTenant: p.runnerTenant, skillId: p.skillId, cap: p.cap, limitKind: p.limitKind };
    case 'skill_fed_real_requested':
    case 'skill_fed_real_approved_owner':
    case 'skill_fed_real_approved_runner':
    case 'skill_fed_real_executed':
    case 'skill_fed_real_denied':
      return { runId: p.runId, skillId: p.skillId };
    case 'approval':
      return { approvalId: p.approvalId, decision: p.decision };
    case 'run':
      return { runId: p.runId, status: p.status };
    case 'quota':
    case 'quota_exceeded':
    case 'tenant_quota_exceeded':
      return { kind: p.kind, used: p.used, limit: p.limit };
    case 'quota_disk_warning':
      return { tenant: p.tenant, usedMb: p.usedMb, limitMb: p.limitMb, pct: p.pct };
    case 'quota_api_warning':
      return { tenant: p.tenant, apiCount: p.apiCount, limit: p.limit, pct: p.pct };
    case 'palette_command':
      return { palette: p.palette };
    case 'observability_read':
    case 'observability_denied':
    case 'federation_audit_read':
    case 'federation_audit_denied':
      return { by: p.by };
    default:
      return { type: 'restricted' };
  }
}

/**
 * Get events for one tenant. Returns {events, count, since, until}.
 * Filters: since, until, type, limit.
 */
function getTenantEvents(tenant, filters = {}) {
  if (!enabled()) return { events: [], count: 0 };
  if (!tenant) return { events: [], count: 0 };

  const clauses = [`json_extract(payload, '$.tenant') = ?`];
  const params = [tenant];

  if (Number.isFinite(filters.since)) {
    clauses.push('ts >= ?');
    params.push(filters.since);
  }
  if (Number.isFinite(filters.until)) {
    clauses.push('ts <= ?');
    params.push(filters.until);
  }
  if (filters.type) {
    clauses.push('type = ?');
    params.push(filters.type);
  }

  const lim = Math.max(1, Math.min(Number.isFinite(filters.limit) ? filters.limit : DEFAULT_LIMIT, MAX_LIMIT));
  const where = 'WHERE ' + clauses.join(' AND ');

  let rows = [];
  try {
    rows = db.prepare(
      `SELECT seq, ts, type, payload, bot FROM audit_chain ${where} ORDER BY ts DESC LIMIT ?`
    ).all(...params, lim);
  } catch {
    // audit_chain may not exist in test contexts
    return { events: [], count: 0 };
  }

  const events = rows.map(r => ({
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    bot: r.bot,
    payloadSummary: _summary(r.type, r.payload),
  }));

  return {
    events,
    count: events.length,
    since: filters.since || null,
    until: filters.until || null,
  };
}

module.exports = {
  enabled,
  getTenantEvents,
  KNOWN_TYPES,
};
