'use strict';
// FS-A5 phase 2 — users store migration (SQLite unification).
//
// Two modes, selected by env at call time (never at module load, so tests can
// toggle per gateway instance):
//
//   TG_USERS_DB=1  →  getUsers(gw) returns a DB-backed UserStore on the
//       unified data/gateway.db (db.js single connection). On FIRST access the
//       existing data/users.json is imported into a `users` table (fail closed
//       on corrupt/duplicate/malformed JSON, same as users.js), after which all
//       reads and writes hit the DB — the JSON file is no longer touched.
//       Subsequent accesses/restarts load from the DB (JSON is NOT re-imported
//       while the table is non-empty).
//
//   env unset  →  getUsers(gw) re-exports the legacy JSON-backed UserStore
//       (same file resolution as the 101-auth mount: TG_USERS_FILE or
//       data/users.json) — byte-identical legacy behaviour, cached per
//       gateway in a WeakMap so repeated calls return the SAME instance.
//
// The UserStore surface (create/list/getByEmail/getById/verifyPassword/
// setPassword/setRole/setDisabled/project) is unchanged. scrypt hash + salt
// columns are NOT projected anywhere new — project() still strips them.

const path = require('node:path');
const { db, tx, json } = require('./db');
const { UserStore, DEFAULT_FILE } = require('./users');

const DEFAULT_TABLE = 'users';

class UserStoreDb extends UserStore {
  /**
   * @param {object} opts
   * @param {string} [opts.jsonFile] users.json path to import from
   *                                  (default data/users.json, same resolution as users.js).
   * @param {string} [opts.table]    table name (default users).
   * @param {Function} [opts.now]    clock override (tests).
   * @param {string} [opts.firstUserRole] role for the first registered user.
   */
  constructor({ jsonFile, table = DEFAULT_TABLE, now, firstUserRole } = {}) {
    // file: null → the base class never touches the JSON file; persistence is
    // overridden below to write to SQLite instead.
    super({ file: null, now, firstUserRole });
    this.table = String(table);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table)) {
      throw new Error(`users-db: invalid table name ${this.table}`);
    }
    this.jsonFile = jsonFile ?? path.join(process.cwd(), 'data', 'users.json');
    this.db = db; // shared single connection from db.js
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt          TEXT NOT NULL,
        role          TEXT NOT NULL,
        display_name  TEXT,
        created_at    TEXT NOT NULL,
        disabled      INTEGER NOT NULL DEFAULT 0
      );
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
    // Persist the resolved state so the table is authoritative from now on.
    this._save();
  }

  _importJson() {
    const fs = require('node:fs');
    if (!fs.existsSync(this.jsonFile)) return; // nothing to import — fresh install
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    } catch {
      throw new Error('users: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('users: file must be a JSON array');
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(id, email, password_hash, salt, role, display_name, created_at, disabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, password_hash = excluded.password_hash,
           salt = excluded.salt, role = excluded.role,
           display_name = excluded.display_name, created_at = excluded.created_at,
           disabled = excluded.disabled`
      );
      const seen = new Set();
      for (const u of arr) {
        // Identical validation to users.js _load — fail closed on anything odd.
        if (!u || typeof u.id !== 'string' || typeof u.email !== 'string' || typeof u.passwordHash !== 'string')
          throw new Error('users: entry missing id/email/passwordHash');
        if (seen.has(u.email)) throw new Error('users: duplicate email on load (fail closed)');
        seen.add(u.email);
        ins.run(
          u.id,
          u.email,
          u.passwordHash,
          typeof u.salt === 'string' ? u.salt : null,
          u.role,
          u.display_name ?? null,
          u.created_at,
          u.disabled ? 1 : 0
        );
      }
    });
  }

  _loadFromDb() {
    const rows = this.db
      .prepare(
        `SELECT id, email, password_hash, salt, role, display_name, created_at, disabled
         FROM ${this.table} ORDER BY created_at, id`
      )
      .all();
    this.users = new Map(); // DB is authoritative once we get here
    this._byEmail = new Map();
    for (const r of rows) {
      this.users.set(r.id, {
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        salt: r.salt,
        role: r.role,
        display_name: r.display_name,
        created_at: r.created_at,
        disabled: !!r.disabled,
      });
      this._byEmail.set(r.email, r.id);
    }
  }

  // ── persistence override: SQLite, transactional, no JSON touched ──
  // (file stays null forever in DB mode — no JSON write, unlike the base class.)
  _save() {
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(id, email, password_hash, salt, role, display_name, created_at, disabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, password_hash = excluded.password_hash,
           salt = excluded.salt, role = excluded.role,
           display_name = excluded.display_name, created_at = excluded.created_at,
           disabled = excluded.disabled`
      );
      const del = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);
      const keep = new Set();
      for (const u of this.users.values()) {
        keep.add(u.id);
        ins.run(
          u.id,
          u.email,
          u.passwordHash,
          u.salt,
          u.role,
          u.display_name ?? null,
          u.created_at,
          u.disabled ? 1 : 0
        );
      }
      // Remove rows whose user vanished from the map.
      for (const r of this.db.prepare(`SELECT id FROM ${this.table}`).all()) {
        if (!keep.has(r.id)) del.run(r.id);
      }
    });
  }
}

// One store per gateway instance (WeakMap, like providers-singleton) — for
// BOTH modes, so getUsers(gw) === getUsers(gw) always (instance identity).
const stores = new WeakMap();

function getUsers(gw, opts = {}) {
  const dbMode =
    opts.force === 'db' ||
    (opts.force === undefined && process.env.TG_USERS_DB === '1');
  let s = stores.get(gw);
  if (!s) {
    if (dbMode) {
      // In DB mode a legacy-style `file` option is the import source.
      s = new UserStoreDb({ ...opts, jsonFile: opts.jsonFile ?? opts.file });
    } else {
      // Byte-identical legacy: same file resolution as the 101-auth mount.
      s = new UserStore({
        file: opts.file ?? process.env.TG_USERS_FILE ?? DEFAULT_FILE,
        now: opts.now,
        firstUserRole: opts.firstUserRole,
      });
    }
    stores.set(gw, s);
  }
  return s;
}

module.exports = { getUsers, UserStoreDb, DEFAULT_TABLE, DEFAULT_FILE };