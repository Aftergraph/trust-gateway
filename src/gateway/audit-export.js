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

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_chain (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant    TEXT,
      type      TEXT NOT NULL,
      data      TEXT,
      prev_hash TEXT,
      ts        INTEGER NOT NULL,
      hash      TEXT NOT NULL
    )
  `);
}

function exportEvents(opts) {
  if (!enabled()) return null;
  _ensureTable();
  const { tenant, type, since, until, limit } = opts || {};
  const conditions = [];
  const params = [];
  if (tenant) { conditions.push('tenant = ?'); params.push(tenant); }
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (since) { conditions.push('ts >= ?'); params.push(Number(since)); }
  if (until) { conditions.push('ts <= ?'); params.push(Number(until)); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const lim = Math.min(Number(limit) || 10000, 100000);
  const rows = db.prepare(
    `SELECT id, tenant, type, data, ts, hash FROM audit_chain ${where} ORDER BY id ASC LIMIT ?`
  ).all(...params, lim);
  const tmpFile = path.join(os.tmpdir(), `audit-export-${Date.now()}.jsonl`);
  const lines = rows.map(r => JSON.stringify({
    id: r.id,
    tenant: r.tenant,
    type: r.type,
    data: (() => { try { return JSON.parse(r.data); } catch { return r.data; } })(),
    ts: r.ts,
    hash: r.hash,
  }));
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  return { file: tmpFile, count: rows.length };
}

function applyRetention() {
  if (!enabled()) return null;
  const retentionMs = Number(process.env.TG_AUDIT_RETENTION_MS);
  if (!retentionMs || retentionMs <= 0) return { pruned: 0, reason: 'no_retention_policy' };
  _ensureTable();
  const cutoff = Date.now() - retentionMs;
  const info = db.prepare('DELETE FROM audit_chain WHERE ts < ?').run(cutoff);
  return { pruned: Number(info.changes || 0), cutoffTs: cutoff, retentionMs };
}

module.exports = { enabled, exportEvents, applyRetention };
