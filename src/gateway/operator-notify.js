'use strict';
// FS-W3 — operator notification preferences.
// Per-operator opt-in to specific audit event categories. Backed by
// SQLite. This slice is the preferences store ONLY; actual delivery
// (webhook, email) is a future slice.
//
// Inert when TG_OPERATOR_NOTIFY unset (returns empty arrays / false).

const { db, tx } = require('./db');

const TABLE = 'operator_notify_prefs';

function enabled() {
  return process.env.TG_OPERATOR_NOTIFY === '1';
}

function _ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      operator   TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel    TEXT NOT NULL DEFAULT 'audit_chain',
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (operator, event_type, channel)
    );
  `);
}

function get(operator) {
  if (!enabled() || !operator) return [];
  _ensureTable();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT event_type, channel, enabled, updated_at FROM ${TABLE} WHERE operator = ? ORDER BY event_type`
    ).all(operator);
  } catch { return []; }
  return rows.map(r => ({
    eventType: r.event_type,
    channel: r.channel,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
  }));
}

function set(operator, eventType, channel, enabledFlag) {
  if (!enabled() || !operator || !eventType) return false;
  _ensureTable();
  const at = Date.now();
  const ch = channel || 'audit_chain';
  const flag = enabledFlag === false ? 0 : 1;
  tx(() => {
    db.prepare(
      `INSERT INTO ${TABLE}(operator, event_type, channel, enabled, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(operator, event_type, channel) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`
    ).run(operator, eventType, ch, flag, at);
  });
  return true;
}

function remove(operator, eventType, channel) {
  if (!enabled() || !operator || !eventType) return false;
  _ensureTable();
  const ch = channel || 'audit_chain';
  const info = db.prepare(
    `DELETE FROM ${TABLE} WHERE operator = ? AND event_type = ? AND channel = ?`
  ).run(operator, eventType, ch);
  return Number(info.changes || 0) > 0;
}

function isSubscribed(operator, eventType, channel) {
  if (!enabled() || !operator || !eventType) return false;
  _ensureTable();
  let r;
  try {
    r = db.prepare(
      `SELECT enabled FROM ${TABLE} WHERE operator = ? AND event_type = ? AND channel = ?`
    ).get(operator, eventType, channel || 'audit_chain');
  } catch { return false; }
  return !!(r && r.enabled === 1);
}

function listSubscribers(eventType, channel) {
  if (!enabled() || !eventType) return [];
  _ensureTable();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT operator FROM ${TABLE} WHERE event_type = ? AND channel = ? AND enabled = 1`
    ).all(eventType, channel || 'audit_chain');
  } catch { return []; }
  return rows.map(r => r.operator);
}

module.exports = {
  enabled,
  get,
  set,
  remove,
  isSubscribed,
  listSubscribers,
  TABLE,
};
