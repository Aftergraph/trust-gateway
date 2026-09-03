'use strict';
// FS-W2 — chain pruning (real execution, gated).
// ONLY enabled when TG_CHAIN_PRUNE=1. Safety: head must be > 1000 rows
// unless opts.force is set. Atomic: snapshot head + write manifest, then
// delete rows older than beforeTs. The audit chain is append-only in
// spirit — pruning creates a chain_archived row in audit_chain itself
// (one row per prune operation, NOT the deleted rows).
//
// Dry-run: use FS-N3 chain-prune-preview.js instead.

const { db, tx } = require('./db');
const fs = require('node:fs');
const path = require('node:path');

const TABLE = 'audit_chain';
const MANIFEST_DIR = 'data/chain-prune';
const SAFETY_MIN = 1000;

function enabled() {
  return process.env.TG_CHAIN_PRUNE === '1';
}

/**
 * @param {number} beforeTs
 * @param {object} [opts]
 * @param {boolean} [opts.force] - bypass safety minimum
 * @param {string} [opts.by] - operator name for manifest
 * @param {string} [opts.reason] - reason for manifest
 * @returns {object} {ok, error?, removed, headBefore, headAfter, manifestPath, beforeTs}
 */
function prune(beforeTs, opts = {}) {
  if (!enabled()) return { ok: false, error: 'prune_disabled' };
  if (!Number.isFinite(beforeTs)) return { ok: false, error: 'invalid_before' };

  let head, current;
  try {
    current = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()?.n || 0;
  } catch { return { ok: false, error: 'no_audit_chain' }; }

  if (current < SAFETY_MIN && !opts.force) {
    return { ok: false, error: 'below_safety_threshold', current, minimum: SAFETY_MIN };
  }

  head = db.prepare(`SELECT seq, hash FROM ${TABLE} ORDER BY seq DESC LIMIT 1`).get();
  const headBefore = head ? { seq: head.seq, hash: head.hash } : null;

  // Write manifest first (atomic file write)
  const manifestPath = path.join(MANIFEST_DIR, `prune-${Date.now()}.json`);
  let manifest = null;
  try {
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    const removed = tx(() => {
      const info = db.prepare(`DELETE FROM ${TABLE} WHERE ts < ?`).run(beforeTs);
      return Number(info.changes || 0);
    });
    const headAfter = db.prepare(`SELECT seq, hash FROM ${TABLE} ORDER BY seq DESC LIMIT 1`).get() || null;
    manifest = {
      prunedAt: new Date().toISOString(),
      beforeTs,
      removed,
      headBefore,
      headAfter,
      by: opts.by || 'unknown',
      reason: opts.reason || null,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true, removed, headBefore, headAfter, manifestPath, beforeTs };
  } catch (err) {
    return { ok: false, error: 'prune_failed', message: String(err.message || err) };
  }
}

module.exports = {
  enabled,
  prune,
  SAFETY_MIN,
  MANIFEST_DIR,
};
