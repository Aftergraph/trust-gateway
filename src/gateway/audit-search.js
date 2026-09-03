'use strict';
// FS-N2 — operator audit-log search.
//
// search({type, since, until, bot, tenant, limit}) returns audit rows
// matching the filters, ordered by ts DESC. Uses the existing
// audit_chain table; no new schema.
//
// Inert (returns []) when TG_AUDIT_SEARCH unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_AUDIT_SEARCH === '1';
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function search(filters = {}) {
  if (!enabled()) return [];
  const clauses = [];
  const params = [];
  if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
  if (filters.bot) { clauses.push('bot = ?'); params.push(filters.bot); }
  if (filters.tenant) {
    clauses.push(`(json_extract(payload, '$.tenant') = ? OR json_extract(payload, '$.fromTenant') = ? OR json_extract(payload, '$.toTenant') = ?)`);
    params.push(filters.tenant, filters.tenant, filters.tenant);
  }
  if (Number.isFinite(filters.since)) { clauses.push('ts >= ?'); params.push(filters.since); }
  if (Number.isFinite(filters.until)) { clauses.push('ts <= ?'); params.push(filters.until); }
  if (filters.payloadHas) {
    clauses.push(`json_extract(payload, '$.' || ?) IS NOT NULL`);
    params.push(filters.payloadHas);
  }
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const lim = Math.max(1, Math.min(Number.isFinite(filters.limit) ? filters.limit : DEFAULT_LIMIT, MAX_LIMIT));
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT seq, ts, type, bot, payload FROM audit_chain ${where} ORDER BY ts DESC LIMIT ?`
    ).all(...params, lim);
  } catch {
    return [];
  }
  return rows.map(r => ({
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    bot: r.bot,
    payload: (() => { try { return JSON.parse(r.payload); } catch { return null; } })(),
  }));
}

function count(filters = {}) {
  if (!enabled()) return 0;
  const result = search({ ...filters, limit: MAX_LIMIT });
  return result.length;
}

module.exports = { enabled, search, count };
