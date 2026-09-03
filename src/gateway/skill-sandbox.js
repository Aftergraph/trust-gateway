'use strict';
// FS-X2 — skill execution sandboxing (per-skill sandbox profile).
// Extends the FS-F3 sandbox with per-skill profile persistence.
// Each skill can declare a sandbox profile (network, fs-write, timeout)
// stored in a SQLite table. The executor reads this before launching
// a skill run.
//
// Inert (returns null/no-op) when TG_SKILL_SANDBOX unset.

const { db, tx } = require('./db');

const TABLE = 'skill_sandbox_profiles';

function enabled() {
  return process.env.TG_SKILL_SANDBOX === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      skill_id        TEXT PRIMARY KEY,
      network         TEXT NOT NULL DEFAULT 'none',
      fs_write        INTEGER NOT NULL DEFAULT 0,
      timeout_ms      INTEGER NOT NULL DEFAULT 30000,
      memory_mb       INTEGER NOT NULL DEFAULT 512,
      updated_at      INTEGER NOT NULL,
      updated_by      TEXT
    );
  `);
}

const VALID_NETWORK = new Set(['none', 'loopback', 'any']);

/**
 * @param {string} skillId
 * @param {object} profile {network?, fsWrite?, timeoutMs?, memoryMb?}
 * @param {string} by
 * @returns {object} {ok, error?}
 */
function set(skillId, profile, by) {
  if (!enabled()) return null;
  if (!skillId) return { ok: false, error: 'missing_skill_id' };
  const p = profile || {};
  const network = VALID_NETWORK.has(p.network) ? p.network : 'none';
  const fsWrite = p.fsWrite ? 1 : 0;
  const timeoutMs = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 30000;
  const memoryMb = Number.isFinite(p.memoryMb) && p.memoryMb > 0 ? p.memoryMb : 512;
  _ensureTable();
  const at = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(skill_id, network, fs_write, timeout_ms, memory_mb, updated_at, updated_by)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id) DO UPDATE SET
         network = excluded.network,
         fs_write = excluded.fs_write,
         timeout_ms = excluded.timeout_ms,
         memory_mb = excluded.memory_mb,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).run(skillId, network, fsWrite, timeoutMs, memoryMb, at, by || 'unknown');
  });
  return { ok: true, skillId, network, fsWrite, timeoutMs, memoryMb, updatedAt: at };
}

function get(skillId) {
  if (!enabled() || !skillId) return null;
  _ensureTable();
  let r;
  try {
    r = db.prepare(`SELECT * FROM ${TABLE} WHERE skill_id = ?`).get(skillId);
  } catch { return null; }
  if (!r) return null;
  return {
    skillId: r.skill_id,
    network: r.network,
    fsWrite: r.fs_write === 1,
    timeoutMs: r.timeout_ms,
    memoryMb: r.memory_mb,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function remove(skillId) {
  if (!enabled() || !skillId) return false;
  _ensureTable();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE skill_id = ?`).run(skillId);
  return Number(info.changes || 0) > 0;
}

function list() {
  if (!enabled()) return [];
  _ensureTable();
  let rows = [];
  try { rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY skill_id`).all(); } catch { return []; }
  return rows.map(r => ({
    skillId: r.skill_id,
    network: r.network,
    fsWrite: r.fs_write === 1,
    timeoutMs: r.timeout_ms,
    memoryMb: r.memory_mb,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

/**
 * Compute effective sandbox args for a run, given a skill's profile.
 * Falls back to FS-F3 defaults (sandbox.js) if no profile.
 */
function effectiveArgs(skillId) {
  const profile = get(skillId);
  if (!profile) return null; // signal: use defaults
  return {
    network: profile.network,
    fsWrite: profile.fsWrite,
    timeoutMs: profile.timeoutMs,
    memoryMb: profile.memoryMb,
  };
}

module.exports = {
  enabled,
  set,
  get,
  remove,
  list,
  effectiveArgs,
  VALID_NETWORK,
  TABLE,
};
