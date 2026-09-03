'use strict';
// FS-A4 — generic key/value store over the shared gateway SQLite db.
//
// Backed by the kv_store table created in db.js:
//   kv_store(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)
// Values are JSON-serialized (json()/unjson() from db.js), so any
// JSON-safe value round-trips: objects, arrays, numbers, strings, null.
//
// All writes go through tx() from db.js, so:
//   - a single set/del is atomic on its own, and
//   - composed inside a caller's transaction they join it (nested tx()),
//     letting multi-key updates commit or roll back as one unit.
//
// Usage:
//   const { KV } = require('./kvstore');
//   const kv = new KV();                 // shared db connection
//   kv.set('cfg:llm', { model: 'x' });
//   kv.get('cfg:llm');                   // → { model: 'x' }
//   kv.list('cfg:');                     // → [{key, value}, ...] ordered

const { db, tx, json, unjson } = require('./db');

class KV {
  /**
   * @param {object} [opts]
   * @param {string} [opts.table] Table name (default kv_store).
   * @param {import('node:sqlite').DatabaseSync} [opts.db] Override connection (tests).
   */
  constructor({ table = 'kv_store', db: dbh = db } = {}) {
    this.table = table;
    this.db = dbh;
    dbh.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Get a JSON-decoded value; null when the key is absent. */
  get(key) {
    const row = this.db
      .prepare(`SELECT value FROM ${this.table} WHERE key = ?`)
      .get(String(key));
    return row ? unjson(row.value) : null;
  }

  /** Get the raw stored row {key, value, updated_at}; null when absent. */
  getRow(key) {
    return (
      this.db
        .prepare(`SELECT key, value, updated_at FROM ${this.table} WHERE key = ?`)
        .get(String(key)) || null
    );
  }

  /**
   * Set a key to a JSON-serializable value. Returns the row written.
   * Transactional: joins an outer tx() when one is active.
   */
  set(key, value) {
    const k = String(key);
    const v = json(value);
    const now = Date.now();
    return tx(() => {
      this.db
        .prepare(
          `INSERT INTO ${this.table}(key, value, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(k, v, now);
      return this.getRow(k);
    });
  }

  /** Delete a key. Returns true when a row was removed. Transactional. */
  del(key) {
    return tx(() => {
      const r = this.db
        .prepare(`DELETE FROM ${this.table} WHERE key = ?`)
        .run(String(key));
      return r.changes > 0;
    });
  }

  /**
   * List entries whose key starts with prefix (default: all), ordered by key.
   * Values are JSON-decoded: [{key, value}, ...].
   */
  list(prefix = '') {
    const rows = this.db
      .prepare(
        `SELECT key, value FROM ${this.table} WHERE key LIKE ? ESCAPE '\\' ORDER BY key`
      )
      .all(escapeLike(String(prefix)) + '%');
    return rows.map((r) => ({ key: r.key, value: unjson(r.value) }));
  }

  /** Count entries matching prefix (cheap existence/coverage check). */
  count(prefix = '') {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table} WHERE key LIKE ? ESCAPE '\\'`)
      .get(escapeLike(String(prefix)) + '%');
    return row.n;
  }
}

// Escape LIKE wildcards in user-supplied prefixes so list('a%b') matches
// the literal key prefix, not a pattern.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

module.exports = { KV };
