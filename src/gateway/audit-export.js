'use strict';
// FS-Z5 — audit export + retention policy.
// Exports audit_chain events as JSONL with optional tenant/type filters.
// Retention policy: auto-prune events older than TG_AUDIT_RETENTION_MS.
// Inert when TG_AUDIT_EXPORT unset.

const { db } = require('./db');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function enabled() {
  return process.env.TG_AUDIT_EXPORT === '1';
}

function _parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return {}; }
}

function exportEvents(opts) {
  if (!enabled()) return null;
  const { tenant, type, since, until, limit } = opts || {};
  const lim = Math.min(Number(limit) || 10000, 100000);
  const tsSince = since ? Number(since) : 0;
  const tsUntil = until ? Number(until) : Date.now() + 86400000;
  const rows = db.prepare(
    'SELECT seq, payload, ts, hash FROM chain_entries WHERE ts >= ? AND ts <= ? ORDER BY seq ASC'
  ).all(tsSince, tsUntil);
  let filtered = rows.map(r => ({ ...r, parsed: _parsePayload(r.payload) }));
  if (tenant) filtered = filtered.filter(r => r.parsed.tenant === tenant);
  if (type) filtered = filtered.filter(r => r.parsed.type === type);
  filtered = filtered.slice(0, lim);
  const tmpFile = path.join(os.tmpdir(), `audit-export-${Date.now()}.jsonl`);
  const lines = filtered.map(r => JSON.stringify({
    id: r.seq,
    tenant: r.parsed.tenant,
    type: r.parsed.type,
    data: r.parsed.data || r.parsed,
    ts: r.ts,
    hash: r.hash,
  }));
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  return { file: tmpFile, count: filtered.length };
}

function applyRetention() {
  if (!enabled()) return null;
  const retentionMs = Number(process.env.TG_AUDIT_RETENTION_MS);
  if (!retentionMs || retentionMs <= 0) return { pruned: 0, reason: 'no_retention_policy' };
  const cutoff = Date.now() - retentionMs;
  const info = db.prepare('DELETE FROM chain_entries WHERE ts < ?').run(cutoff);
  return { pruned: Number(info.changes || 0), cutoffTs: cutoff, retentionMs };
}

module.exports = { enabled, exportEvents, applyRetention };
