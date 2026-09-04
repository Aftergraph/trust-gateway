'use strict';
// FS-Z3 — skill marketplace search/filter.
// Extends FS-F4 marketplace with search, tag filtering, and pagination.
// Inert when TG_SKILL_MARKET_SEARCH unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_SKILL_MARKET_SEARCH === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_marketplace (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT,
      tags        TEXT,
      owner       TEXT NOT NULL,
      visibility  TEXT NOT NULL DEFAULT 'public',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);
}

function search(opts) {
  if (!enabled()) return null;
  _ensureTable();
  const { q, tag, visibility, limit, offset } = opts || {};
  const conditions = [];
  const params = [];
  if (q) {
    conditions.push('(name LIKE ? OR description LIKE ? OR slug LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (tag) {
    conditions.push('tags LIKE ?');
    params.push(`%${tag}%`);
  }
  if (visibility) {
    conditions.push('visibility = ?');
    params.push(visibility);
  } else {
    conditions.push("visibility = 'public'");
  }
  const where = 'WHERE ' + conditions.join(' AND ');
  const lim = Math.min(Number(limit) || 20, 100);
  const off = Number(offset) || 0;
  const rows = db.prepare(
    `SELECT id, slug, name, description, tags, owner, visibility, created_at, updated_at
     FROM skill_marketplace ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, lim, off);
  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM skill_marketplace ${where}`
  ).get(...params);
  return {
    total: Number(countRow.cnt),
    limit: lim,
    offset: off,
    skills: rows.map(r => ({
      ...r,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
    })),
  };
}

module.exports = { enabled, search };
