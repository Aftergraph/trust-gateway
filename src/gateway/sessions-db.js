'use strict';
// FS-A5 phase 2 — sessions store migration (SQLite unification).
//
// Two modes, selected by env at call time (never at module load, so tests can
// toggle per gateway instance):
//
//   TG_SESSIONS_DB=1  →  getSessions(gw) returns a DB-backed SessionStore on
//       the unified data/gateway.db (db.js single connection). On FIRST access
//       the existing data/sessions.json is imported into a `sessions` table
//       (fail closed on corrupt/malformed JSON, same as sessions.js), after
//       which all reads and writes hit the DB — the JSON file is no longer
//       touched. Subsequent accesses/restarts load from the DB (JSON is NOT
//       re-imported while the table is non-empty).
//
//   env unset  →  getSessions(gw) re-exports the legacy JSON-backed
//       SessionStore (same file resolution as the 101-auth mount:
//       TG_SESSIONS_FILE or data/sessions.json) — byte-identical legacy
//       behaviour, cached per gateway in a WeakMap so repeated calls return
//       the SAME instance.
//
// Behaviour preserved: the plaintext token is NEVER stored (only sha256 hex
// as the key), TTL is 7-day SLIDING (get() extends expiry), max 200 sessions
// per user with soonest-to-expire eviction.

const path = require('node:path');
const { db, tx } = require('./db');
const { SessionStore, DEFAULT_FILE } = require('./sessions');

const DEFAULT_TABLE = 'sessions';

class SessionStoreDb extends SessionStore {
  /**
   * @param {object} opts
   * @param {string} [opts.jsonFile] sessions.json path to import from
   *                                  (default data/sessions.json).
   * @param {string} [opts.table]    table name (default sessions).
   * @param {Function} [opts.now]    clock override (tests).
   * @param {number} [opts.ttlMs]    sliding TTL override.
   * @param {number} [opts.maxPerUser] per-user session cap override.
   */
  constructor({ jsonFile, table = DEFAULT_TABLE, now, ttlMs, maxPerUser } = {}) {
    // file: null → the base class never touches the JSON file; persistence is
    // overridden below to write to SQLite instead.
    super({ file: null, now, ttlMs, maxPerUser });
    this.table = String(table);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table)) {
      throw new Error(`sessions-db: invalid table name ${this.table}`);
    }
    this.jsonFile = jsonFile ?? path.join(process.cwd(), 'data', 'sessions.json');
    this.db = db; // shared single connection from db.js
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.table}_user_idx
        ON ${this.table}(user_id);
    `);
    this._loadOrImport();
  }

  // ── first access: import JSON → table, then read state from the DB ──
  _loadOrImport() {
    const count = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table}`)
      .get().n;
    if (count === 0) this._importJson();
    this._loadFromDb();
    this._save();
  }

  _importJson() {
    const fs = require('node:fs');
    if (!fs.existsSync(this.jsonFile)) return; // nothing to import — fresh install
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    } catch {
      throw new Error('sessions: file unparseable — refusing to load (fail closed)');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error('sessions: file must be a JSON object keyed by token hash');
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(token_hash, user_id, created_at, last_used_at, expires_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           user_id = excluded.user_id, created_at = excluded.created_at,
           last_used_at = excluded.last_used_at, expires_at = excluded.expires_at`
      );
      for (const [hash, s] of Object.entries(doc)) {
        // Identical validation to sessions.js _load — fail closed.
        if (!/^[0-9a-f]{64}$/.test(hash) || !s || typeof s.userId !== 'string')
          throw new Error('sessions: entry malformed (fail closed)');
        ins.run(hash, s.userId, s.createdAt, s.lastUsedAt, s.expiresAt);
      }
    });
  }

  _loadFromDb() {
    const rows = this.db
      .prepare(
        `SELECT token_hash, user_id, created_at, last_used_at, expires_at FROM ${this.table}`
      )
      .all();
    this.sessions = new Map(); // DB is authoritative once we get here
    for (const r of rows) {
      this.sessions.set(r.token_hash, {
        userId: r.user_id,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
      });
    }
  }

  // ── persistence override: SQLite, transactional, no JSON touched ──
  // Called on every sliding-TTL touch, so keep it one small transaction.
  _save() {
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(token_hash, user_id, created_at, last_used_at, expires_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           user_id = excluded.user_id, created_at = excluded.created_at,
           last_used_at = excluded.last_used_at, expires_at = excluded.expires_at`
      );
      const del = this.db.prepare(`DELETE FROM ${this.table} WHERE token_hash = ?`);
      const keep = new Set();
      for (const [hash, s] of this.sessions) {
        keep.add(hash);
        ins.run(hash, s.userId, s.createdAt, s.lastUsedAt, s.expiresAt);
      }
      // Remove rows whose session vanished (revoked / swept / evicted).
      for (const r of this.db
        .prepare(`SELECT token_hash FROM ${this.table}`)
        .all()) {
        if (!keep.has(r.token_hash)) del.run(r.token_hash);
      }
    });
  }
}

// One store per gateway instance (WeakMap, like providers-singleton) — for
// BOTH modes, so getSessions(gw) === getSessions(gw) always.
const stores = new WeakMap();

function getSessions(gw, opts = {}) {
  const dbMode =
    opts.force === 'db' ||
    (opts.force === undefined && process.env.TG_SESSIONS_DB === '1');
  let s = stores.get(gw);
  if (!s) {
    if (dbMode) {
      // In DB mode a legacy-style `file` option is the import source.
      s = new SessionStoreDb({ ...opts, jsonFile: opts.jsonFile ?? opts.file });
    } else {
      // Byte-identical legacy: same file resolution as the 101-auth mount.
      s = new SessionStore({
        file: opts.file ?? process.env.TG_SESSIONS_FILE ?? DEFAULT_FILE,
        now: opts.now,
        ttlMs: opts.ttlMs,
        maxPerUser: opts.maxPerUser,
      });
    }
    stores.set(gw, s);
  }
  return s;
}

module.exports = { getSessions, SessionStoreDb, DEFAULT_TABLE, DEFAULT_FILE };