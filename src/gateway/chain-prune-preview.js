'use strict';
// FS-N3 — chain-pruning preview (dry-run).
//
// preview(beforeTs) returns {totalRows, wouldRemove, wouldKeep, headBefore, headAfter, sampleRemoved}.
// Same logic as a real prune, but the only side effect is reading.
// Inert when TG_CHAIN_PRUNE_PREVIEW unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_CHAIN_PRUNE_PREVIEW === '1';
}

function preview(beforeTs) {
  if (!enabled()) return null;
  if (!Number.isFinite(beforeTs)) return null;
  // Find current head
  let head = null;
  let total = 0;
  try {
    head = db.prepare(`SELECT seq, hash FROM audit_chain ORDER BY seq DESC LIMIT 1`).get();
    total = db.prepare(`SELECT COUNT(*) AS n FROM audit_chain`).get()?.n || 0;
  } catch { return null; }
  const wouldRemove = db.prepare(`SELECT COUNT(*) AS n FROM audit_chain WHERE ts < ?`).get(beforeTs)?.n || 0;
  const wouldKeep = total - wouldRemove;
  const sample = db.prepare(
    `SELECT seq, ts, type, bot FROM audit_chain WHERE ts < ? ORDER BY seq LIMIT 10`
  ).all(beforeTs);
  return {
    totalRows: total,
    wouldRemove,
    wouldKeep,
    headBefore: head ? { seq: head.seq, hash: head.hash } : null,
    headAfter: head ? { seq: head.seq, hash: head.hash, note: 'unchanged in preview' } : null,
    sampleRemoved: sample,
    preview: true,
    beforeTs,
  };
}

module.exports = { enabled, preview };
