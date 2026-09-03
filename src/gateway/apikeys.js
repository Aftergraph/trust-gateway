'use strict';
// FS-E3 — external API keys ("tgk_") with scoped READ access and
// PERSISTENT rate limits.
//
// Storage: SQLite via db.js (the unified connection) —
//   api_keys(id TEXT PRIMARY KEY, name, key_hash TEXT UNIQUE, owner,
//            scopes TEXT, created_at, last_used_at, disabled INTEGER,
//            rate TEXT)            -- rate = JSON {windowMs, max}
//   rate_hits(key_id TEXT, window_start INTEGER, count INTEGER)
//
// Key shape: plaintext `tgk_<32hex>` shown EXACTLY ONCE at create; only the
// sha256 hex is stored. verify() compares timing-safe, updates last_used_at
// and the rate counter ATOMICALLY (tx), so limits survive restarts (R5).
//
// Scopes (fixed allow-list): audit.read, search.read, providers.read,
// memory.read, status.read. Anything else is refused at create.
//
// Fail-closed everywhere: unknown/garbage/disabled → {ok:false}; over-limit
// → {ok:false, reason:'rate_limited'} (the caller answers 401/429 without
// revealing which).

const crypto = require('node:crypto');
const { db, tx } = require('./db');

const SCOPES = ['audit.read', 'search.read', 'providers.read', 'memory.read', 'status.read'];

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class ApiKeyStore {
  constructor({ now } = {}) {
    this.db = db;
    this.now = now ?? (() => Date.now());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        key_hash     TEXT NOT NULL UNIQUE,
        owner        TEXT NOT NULL,
        scopes       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        disabled     INTEGER NOT NULL DEFAULT 0,
        rate         TEXT
      );
      CREATE TABLE IF NOT EXISTS rate_hits (
        key_id       TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count        INTEGER NOT NULL,
        PRIMARY KEY (key_id, window_start)
      );
    `);
  }

  /**
   * Create a key. Returns { ok, id, plaintext, record } — plaintext is
   * returned ONLY here, never persisted, never returned by list/get.
   */
  create({ name, owner, scopes, rate } = {}) {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'invalid_name' };
    if (typeof owner !== 'string' || !owner.trim()) return { ok: false, error: 'invalid_owner' };
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => !SCOPES.includes(s))) {
      return { ok: false, error: 'invalid_scopes' };
    }
    let rateJson = null;
    if (rate !== undefined && rate !== null) {
      if (typeof rate !== 'object' || !Number.isFinite(rate.windowMs) || rate.windowMs <= 0 ||
          !Number.isFinite(rate.max) || rate.max <= 0) {
        return { ok: false, error: 'invalid_rate' };
      }
      rateJson = JSON.stringify({ windowMs: Math.floor(rate.windowMs), max: Math.floor(rate.max) });
    }
    const id = 'ak_' + crypto.randomBytes(4).toString('hex');
    const plaintext = 'tgk_' + crypto.randomBytes(24).toString('hex');
    const ts = this.now();
    tx(() => {
      this.db.prepare(`
        INSERT INTO api_keys(id, name, key_hash, owner, scopes, created_at, disabled, rate)
        VALUES(?, ?, ?, ?, ?, ?, 0, ?)
      `).run(id, name.trim(), sha256(plaintext), owner.trim(), JSON.stringify(scopes), ts, rateJson);
    });
    return { ok: true, id, plaintext, record: this.get(id) };
  }

  _row(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      owner: r.owner,
      scopes: JSON.parse(r.scopes),
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      disabled: !!r.disabled,
      rate: r.rate ? JSON.parse(r.rate) : null,
      key_hint: 'tgk_' + r.key_hash.slice(0, 4) + '…', // never the full hash
    };
  }

  get(id) {
    if (typeof id !== 'string' || !/^ak_[0-9a-f]{8}$/.test(id)) return null;
    return this._row(this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
  }

  list() {
    return this.db.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all().map((r) => this._row(r));
  }

  revoke(id) {
    const k = this.get(id);
    if (!k) return { ok: false, error: 'not_found' };
    this.db.prepare('UPDATE api_keys SET disabled = 1 WHERE id = ?').run(id);
    return { ok: true, record: this.get(id) };
  }

  /**
   * Verify a plaintext key: hash compare (timing-safe), disabled check,
   * then atomically bump the persistent rate counter. Returns
   * { ok:true, record } | { ok:false, reason:'unknown'|'disabled'|'rate_limited' }.
   */
  verify(plaintext) {
    if (typeof plaintext !== 'string' || !/^tgk_[0-9a-f]{48}$/.test(plaintext)) {
      return { ok: false, reason: 'unknown' };
    }
    const hash = sha256(plaintext);
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.disabled) return { ok: false, reason: 'disabled' };

    // Rate limit: counters live in SQLite → they survive restarts (R5).
    const rate = row.rate ? JSON.parse(row.rate) : null;
    const now = this.now();
    let allowed = true;
    if (rate) {
      const windowStart = Math.floor(now / rate.windowMs) * rate.windowMs;
      tx(() => {
        this.db.prepare('DELETE FROM rate_hits WHERE key_id = ? AND window_start < ?')
          .run(row.id, windowStart);
        const hit = this.db.prepare(
          'SELECT count FROM rate_hits WHERE key_id = ? AND window_start = ?'
        ).get(row.id, windowStart);
        const count = hit ? hit.count : 0;
        if (count + 1 > rate.max) {
          allowed = false;
        } else {
          this.db.prepare(`
            INSERT INTO rate_hits(key_id, window_start, count) VALUES(?, ?, 1)
            ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
          `).run(row.id, windowStart);
        }
      });
      if (!allowed) return { ok: false, reason: 'rate_limited' };
    }

    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return { ok: true, record: this.get(row.id) };
  }

  /** Does this key record grant the scope? */
  static hasScope(record, scope) {
    return !!record && Array.isArray(record.scopes) && record.scopes.includes(scope);
  }
}

module.exports = { ApiKeyStore, SCOPES };

// One store per gateway instance (WeakMap singleton pattern).
const stores = new WeakMap();
function getApiKeyStore(gw, opts = {}) {
  let s = stores.get(gw);
  if (!s) {
    s = new ApiKeyStore(opts);
    stores.set(gw, s);
  }
  return s;
}
module.exports.getApiKeyStore = getApiKeyStore;
