'use strict';
// FS-K1 — federation real-run audit dashboard.
//
// Pure read-only aggregator over fed_runs + pending_real_runs tables
// (both live on the shared db.js connection from skills-federation.js).
// Exposes listFederatedRuns(filters) for the operator mount and scalar
// counts for /v2/observability's fed section.
//
// Filters:
//   owner       — owner_tenant match
//   runner      — runner_tenant match
//   skillId     — skill_id match
//   since       — ms timestamp lower bound (requested_at >= since)
//   limit       — max rows returned (default 50, max 500)
//   status      — 'pending' | 'approved' | 'executed' | 'denied'
//                 ('denied' is a synthetic status: requested but never
//                  executed AND at least one approval stamp present —
//                  we cannot distinguish true denial from abandoned
//                  requests without an explicit denied_at column, so
//                  this is best-effort; documented honestly.)
//
// Row payload carries NO secrets, args, steps, or result payloads —
// only ids, tenants, bot name, timestamps, status, resultHash (sha256),
// and durationMs (executedAt - requestedAt when both present).
//
// Inert when TG_SKILLS_FEDERATION unset: the mount returns 404 and
// observabilityFedSection() returns null.

const { db } = require('./db');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * List federated runs (real + pending) with optional filters.
 * Returns {rows, count} where count is the number of rows RETURNED
 * (not total matching — pagination is limit-only for now).
 */
function listFederatedRuns(filters = {}) {
  if (!federationEnabled()) return { rows: [], count: 0 };

  const clauses = [];
  const params = [];

  if (filters.owner) {
    clauses.push('owner_tenant = ?');
    params.push(filters.owner);
  }
  if (filters.runner) {
    clauses.push('runner_tenant = ?');
    params.push(filters.runner);
  }
  if (filters.skillId) {
    clauses.push('skill_id = ?');
    params.push(filters.skillId);
  }
  if (Number.isFinite(filters.since)) {
    clauses.push('requested_at >= ?');
    params.push(filters.since);
  }

  // Status filter: pending_real_runs has explicit states; fed_runs are
  // always 'executed' (dry-run ledger entries). We union both tables.
  // For simplicity in v1: query pending_real_runs for pending/approved/denied,
  // fed_runs for executed. Status filter applies to the union.
  const status = filters.status || null;

  let limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(filters.limit, MAX_LIMIT)) : DEFAULT_LIMIT;

  // Build UNION query: pending_real_runs (with computed status) + fed_runs (status='executed')
  const pendingSelect = `
    SELECT id, skill_id, owner_tenant, runner_tenant, runner_bot,
           requested_at, approved_by_owner, approved_by_runner,
           executed_at, result_hash, 'pending_real' AS source
    FROM pending_real_runs
  `;
  const fedSelect = `
    SELECT id, skill_id, owner_tenant, runner_tenant, runner_bot,
           ran_at AS requested_at, NULL AS approved_by_owner, NULL AS approved_by_runner,
           ran_at AS executed_at, NULL AS result_hash, 'fed_dry' AS source
    FROM fed_runs
  `;

  // Wrap union in outer query for filtering
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `
    SELECT * FROM (
      ${pendingSelect}
      UNION ALL
      ${fedSelect}
    ) AS combined
    ${where}
    ORDER BY requested_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const raw = db.prepare(sql).all(...params);

  // Post-filter by status (computed field, can't do in SQL easily)
  let rows = raw.map(r => _projectRow(r));
  if (status) {
    rows = rows.filter(r => r.status === status);
  }

  return { rows, count: rows.length };
}

/** Scalar counts for /v2/observability fed section. */
function observabilityFedSection() {
  if (!federationEnabled()) return null;

  const now = Date.now();
  const h24 = now - 24 * 60 * 60 * 1000;
  const d7 = now - 7 * 24 * 60 * 60 * 1000;

  const last24hExecuted = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs WHERE executed_at IS NOT NULL AND executed_at >= ?`
  ).get(h24)?.n || 0;

  const last24hPending = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs WHERE executed_at IS NULL AND requested_at >= ?`
  ).get(h24)?.n || 0;

  // 'denied' ≈ has at least one approval but never executed (best-effort)
  const last24hDenied = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs
     WHERE executed_at IS NULL AND requested_at >= ?
       AND (approved_by_owner IS NOT NULL OR approved_by_runner IS NOT NULL)`
  ).get(h24)?.n || 0;

  const last7dExecuted = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs WHERE executed_at IS NOT NULL AND executed_at >= ?`
  ).get(d7)?.n || 0;

  const last7dPending = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs WHERE executed_at IS NULL AND requested_at >= ?`
  ).get(d7)?.n || 0;

  const last7dDenied = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_real_runs
     WHERE executed_at IS NULL AND requested_at >= ?
       AND (approved_by_owner IS NOT NULL OR approved_by_runner IS NOT NULL)`
  ).get(d7)?.n || 0;

  return {
    runs: {
      last24h: { executed: last24hExecuted, denied: last24hDenied, pending: last24hPending },
      last7d:  { executed: last7dExecuted,  denied: last7dDenied,  pending: last7dPending },
    },
  };
}

function federationEnabled() {
  return process.env.TG_SKILLS_FEDERATION === '1';
}

function _projectRow(r) {
  if (!r) return null;
  const executedAt = r.executed_at ?? null;
  const requestedAt = r.requested_at ?? null;
  const approvedByOwner = r.approved_by_owner ?? null;
  const approvedByRunner = r.approved_by_runner ?? null;

  let status;
  if (r.source === 'fed_dry') {
    status = 'executed'; // dry-run ledger = already ran
  } else if (executedAt !== null) {
    status = 'executed';
  } else if (approvedByOwner !== null && approvedByRunner !== null) {
    status = 'approved'; // dual-approved but not yet executed
  } else if (approvedByOwner !== null || approvedByRunner !== null) {
    status = 'denied'; // partial approval, never executed ≈ denied/abandoned
  } else {
    status = 'pending';
  }

  const durationMs = (executedAt !== null && requestedAt !== null)
    ? (executedAt - requestedAt)
    : null;

  return {
    runId: r.id,
    skillId: r.skill_id,
    ownerTenant: r.owner_tenant,
    runnerTenant: r.runner_tenant,
    runnerBot: r.runner_bot,
    requestedAt,
    approvedByOwnerAt: approvedByOwner,
    approvedByRunnerAt: approvedByRunner,
    executedAt,
    resultHash: r.result_hash ?? null,
    status,
    durationMs,
  };
}

module.exports = {
  listFederatedRuns,
  observabilityFedSection,
  federationEnabled,
};
