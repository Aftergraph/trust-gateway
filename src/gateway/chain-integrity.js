'use strict';
// FS-Y2 — chain integrity check endpoint.
// Exposes verifyRange(from, to) and verifyFull() that recompute hashes
// and compare against stored values. Returns {ok, checked, mismatches[]}.
// Inert when TG_CHAIN_INTEGRITY unset.

const { db } = require('./db');
const crypto = require('node:crypto');

function enabled() {
  return process.env.TG_CHAIN_INTEGRITY === '1';
}

function _hash(row) {
  const payload = JSON.stringify({
    id: row.id,
    tenant: row.tenant,
    type: row.type,
    data: row.data,
    prev_hash: row.prev_hash,
    ts: row.ts,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
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

function verifyRange(fromId, toId) {
  if (!enabled()) return null;
  _ensureTable();
  const rows = db.prepare(
    'SELECT id, tenant, type, data, prev_hash, ts, hash FROM audit_chain WHERE id >= ? AND id <= ? ORDER BY id'
  ).all(Number(fromId), Number(toId));
  const mismatches = [];
  for (const r of rows) {
    const expected = _hash(r);
    if (expected !== r.hash) {
      mismatches.push({ id: r.id, expected, stored: r.hash });
    }
  }
  return { ok: mismatches.length === 0, checked: rows.length, mismatches };
}

function verifyFull() {
  if (!enabled()) return null;
  _ensureTable();
  const rows = db.prepare('SELECT id, tenant, type, data, prev_hash, ts, hash FROM audit_chain ORDER BY id').all();
  const mismatches = [];
  for (const r of rows) {
    const expected = _hash(r);
    if (expected !== r.hash) {
      mismatches.push({ id: r.id, expected, stored: r.hash });
    }
  }
  return { ok: mismatches.length === 0, checked: rows.length, mismatches };
}

module.exports = { enabled, verifyRange, verifyFull };
