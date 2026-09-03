'use strict';
// FS-M2 — skill version snapshots (immutable history + rollback).
//
// Table skill_versions(id PK, skill_id, version, steps_json, created_at, created_by).
// snapshot() inserts a NEW version row (never overwrites), getVersion/listVersions
// are reads, rollbackTo() reads a version's steps and writes them back to the
// skill's current steps field via the skills module.
//
// Inert when TG_SKILL_VERSIONS unset — all methods return null.

const { db, tx } = require('./db');

const TABLE = 'skill_versions';

function enabled() {
  return process.env.TG_SKILL_VERSIONS === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id   TEXT NOT NULL,
      version    INTEGER NOT NULL,
      steps_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      UNIQUE(skill_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_skill ON ${TABLE}(skill_id, version DESC);
  `);
}

/**
 * @param {string} skillId
 * @param {Array} steps
 * @param {string} by
 * @returns {object} {version, id} | null if inert
 */
function snapshot(skillId, steps, by) {
  if (!enabled()) return null;
  if (!skillId || !Array.isArray(steps)) {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
  _ensureTable();
  return tx(() => {
    const last = db.prepare(
      `SELECT MAX(version) AS v FROM ${TABLE} WHERE skill_id = ?`
    ).get(skillId);
    const nextVersion = (last && last.v) ? last.v + 1 : 1;
    const at = Date.now();
    const info = db.prepare(
      `INSERT INTO ${TABLE}(skill_id, version, steps_json, created_at, created_by)
       VALUES(?, ?, ?, ?, ?)`
    ).run(skillId, nextVersion, JSON.stringify(steps), at, by || 'unknown');
    return { id: Number(info.lastInsertRowid), version: nextVersion, createdAt: at, createdBy: by };
  });
}

/**
 * @param {string} skillId
 * @param {number} version
 * @returns {object|null} {version, steps, createdAt, createdBy}
 */
function getVersion(skillId, version) {
  if (!enabled()) return null;
  _ensureTable();
  const r = db.prepare(
    `SELECT version, steps_json, created_at, created_by FROM ${TABLE} WHERE skill_id = ? AND version = ?`
  ).get(skillId, version);
  if (!r) return null;
  return {
    version: r.version,
    steps: (() => { try { return JSON.parse(r.steps_json); } catch { return []; } })(),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function listVersions(skillId) {
  if (!enabled()) return [];
  _ensureTable();
  return db.prepare(
    `SELECT version, created_at, created_by FROM ${TABLE} WHERE skill_id = ? ORDER BY version DESC`
  ).all(skillId)
    .map(r => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by }));
}

/**
 * Rollback a skill to a previous version. Returns the version that was rolled
 * back to. Caller (mount) handles the actual write to the live skill + audit.
 */
function rollbackTo(skillId, version) {
  if (!enabled()) return null;
  const v = getVersion(skillId, version);
  if (!v) return null;
  return v;
}

module.exports = {
  enabled,
  snapshot,
  getVersion,
  listVersions,
  rollbackTo,
  TABLE,
};
