'use strict';
// FS-Y2 — chain integrity check endpoint.
// Exposes verifyRange(from, to) and verifyFull() that recompute hashes
// using the canonical hash-chain entryHash formula.
// Returns {ok, checked, mismatches[]}.
// Inert when TG_CHAIN_INTEGRITY unset.

const { db } = require('./db');
const { entryHash } = require('./hash-chain');

function enabled() {
  return process.env.TG_CHAIN_INTEGRITY === '1';
}

function _hash(row) {
  return entryHash(row.seq, row.prev_hash, row.ts, JSON.parse(row.payload));
}

function verifyRange(fromId, toId) {
  if (!enabled()) return null;
  const rows = db.prepare(
    'SELECT seq, payload, prev_hash, ts, hash FROM chain_entries WHERE seq >= ? AND seq <= ? ORDER BY seq'
  ).all(Number(fromId), Number(toId));
  const mismatches = [];
  for (const r of rows) {
    const expected = _hash(r);
    if (expected !== r.hash) {
      mismatches.push({ id: r.seq, expected, stored: r.hash });
    }
  }
  return { ok: mismatches.length === 0, checked: rows.length, mismatches };
}

function verifyFull() {
  if (!enabled()) return null;
  const rows = db.prepare('SELECT seq, payload, prev_hash, ts, hash FROM chain_entries ORDER BY seq').all();
  const mismatches = [];
  for (const r of rows) {
    const expected = _hash(r);
    if (expected !== r.hash) {
      mismatches.push({ id: r.seq, expected, stored: r.hash });
    }
  }
  return { ok: mismatches.length === 0, checked: rows.length, mismatches };
}

module.exports = { enabled, verifyRange, verifyFull };
