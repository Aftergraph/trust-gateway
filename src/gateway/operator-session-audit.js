'use strict';
// FS-Z7 — operator session audit trail.
// Tracks operator login/logout events with IP, user-agent, and session duration.
// Inert when TG_OPERATOR_SESSION_AUDIT unset.

const { db } = require('./db');

function enabled() {
  return process.env.TG_OPERATOR_SESSION_AUDIT === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      operator    TEXT NOT NULL,
      action      TEXT NOT NULL,
      ip          TEXT,
      user_agent  TEXT,
      ts          INTEGER NOT NULL,
      session_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_op_sessions_operator ON operator_sessions(operator);
    CREATE INDEX IF NOT EXISTS idx_op_sessions_ts ON operator_sessions(ts);
  `);
}

function recordLogin(operator, ip, userAgent, sessionId) {
  if (!enabled()) return null;
  _ensureTable();
  const ts = Date.now();
  const info = db.prepare(
    'INSERT INTO operator_sessions(operator, action, ip, user_agent, ts, session_id) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(operator, 'login', ip || null, userAgent || null, ts, sessionId || null);
  return { id: Number(info.lastInsertRowid), operator, action: 'login', ts };
}

function recordLogout(operator, sessionId) {
  if (!enabled()) return null;
  _ensureTable();
  const ts = Date.now();
  const info = db.prepare(
    'INSERT INTO operator_sessions(operator, action, ts, session_id) VALUES(?, ?, ?, ?)'
  ).run(operator, 'logout', ts, sessionId || null);
  return { id: Number(info.lastInsertRowid), operator, action: 'logout', ts };
}

function getSessions(operator, limit) {
  if (!enabled()) return null;
  _ensureTable();
  const lim = Math.min(Number(limit) || 50, 200);
  const rows = db.prepare(
    'SELECT id, operator, action, ip, user_agent, ts, session_id FROM operator_sessions WHERE operator = ? ORDER BY ts DESC LIMIT ?'
  ).all(operator, lim);
  return rows.map(r => ({ ...r }));
}

function getActiveSessions() {
  if (!enabled()) return null;
  _ensureTable();
  // Find operators whose most recent event is a login (not logout)
  const rows = db.prepare(`
    SELECT ls.operator, ls.ts as login_ts, ls.ip, ls.user_agent, ls.session_id
    FROM operator_sessions ls
    WHERE ls.action = 'login'
      AND ls.id = (
        SELECT MAX(latest.id) FROM operator_sessions latest
        WHERE latest.operator = ls.operator
      )
    ORDER BY ls.ts DESC
  `).all();
  return rows.map(r => ({ ...r }));
}

module.exports = { enabled, recordLogin, recordLogout, getSessions, getActiveSessions };
