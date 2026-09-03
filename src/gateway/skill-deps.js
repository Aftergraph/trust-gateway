'use strict';
// FS-W4 — skill dependency graph validation.
// Each skill may declare `requires: [otherSkillId]`. On import/upsert,
// validate: no self-reference, no cycle, all slugs exist (when strict).
// Pure logic — no side effects on import.
//
// Inert (returns ok:skipped) when TG_SKILL_DEPS unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_SKILL_DEPS === '1';
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Validate a single skill's requires field.
 * @param {object} skill {id, requires: [string]}
 * @param {object} [opts] {strict: bool} - strict: require all slugs to exist
 * @returns {object} {ok, error?, missing?, requires?}
 */
function validate(skill, opts = {}) {
  if (!enabled() || !skill) return { ok: true, skipped: true };
  if (!skill.id || !SLUG_RE.test(skill.id)) {
    return { ok: false, error: 'invalid_skill_id' };
  }
  const reqs = Array.isArray(skill.requires) ? skill.requires : [];
  // No self-reference
  if (reqs.includes(skill.id)) {
    return { ok: false, error: 'self_reference', skillId: skill.id };
  }
  // Validate slug format
  for (const r of reqs) {
    if (!SLUG_RE.test(r)) {
      return { ok: false, error: 'invalid_dependency_slug', bad: r };
    }
  }
  // Strict: require all slugs to exist
  if (opts.strict) {
    for (const r of reqs) {
      let exists = false;
      try {
        exists = !!db.prepare(`SELECT 1 FROM skills WHERE id = ?`).get(r);
      } catch { /* table missing → treat as not-exists for strict */ }
      if (!exists) {
        return { ok: false, error: 'missing_dependency', missing: r };
      }
    }
  }
  return { ok: true, requires: reqs };
}

/**
 * Detect cycle in a graph built from current skills table + new skill.
 * @param {string} skillId
 * @param {string[]} newRequires - depends this new skill has
 * @returns {object} {hasCycle: bool, path?: [string]}
 */
function detectCycle(skillId, newRequires) {
  if (!enabled() || !skillId) return { hasCycle: false };
  // Build adjacency: skillId -> requires (from current DB + newRequires for skillId)
  const adj = new Map();
  try {
    const rows = db.prepare(`SELECT id, requires_json FROM skills WHERE id = ?`).all(skillId);
    for (const r of rows) {
      let reqs = [];
      try { reqs = JSON.parse(r.requires_json || '[]'); } catch {}
      adj.set(r.id, reqs);
    }
  } catch { /* no skills table */ }
  adj.set(skillId, Array.isArray(newRequires) ? newRequires : []);

  // DFS from skillId, detect cycle
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const path = [];

  function dfs(node) {
    color.set(node, GRAY);
    path.push(node);
    const neighbors = adj.get(node) || [];
    for (const n of neighbors) {
      if (color.get(n) === GRAY) {
        const cycleStart = path.indexOf(n);
        return path.slice(cycleStart).concat(n);
      }
      if (color.get(n) !== BLACK) {
        const c = dfs(n);
        if (c) return c;
      }
    }
    color.set(node, BLACK);
    path.pop();
    return null;
  }

  const cycle = dfs(skillId);
  return cycle ? { hasCycle: true, path: cycle } : { hasCycle: false };
}

module.exports = {
  enabled,
  validate,
  detectCycle,
  SLUG_RE,
};
