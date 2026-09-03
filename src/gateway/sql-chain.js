'use strict';
// Trust Gateway v2 — SQL-backed, hash-chained, append-only audit log.
// API-compatible with HashChain (append/verify/since/head/entries/chainId),
// but persisted to SQLite (node:sqlite, built-in to Node 24, zero npm deps).
//
// Entry shape matches HashChain: {seq, prevHash, ts, payload, hash}.
// Hash formula is identical to hash-chain.js (sha256 of seq|prevHash|ts|canonical(payload)).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { entryHash, canonical } = require('./hash-chain');

function defaultChainId() {
  return crypto.randomUUID();
}

class SqlChain {
  /**
   * @param {object} opts
   * @param {string} opts.file          Path to sqlite file (e.g. data/gateway.db).
   * @param {string} [opts.chainId]     Optional chainId (random if omitted and db is new).
   * @param {number} [opts.genesisTs]   Optional ts for genesis (now if omitted).
   */
  constructor({ file, chainId, genesisTs } = {}) {
    if (!file) throw new Error('SqlChain: file is required');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.fts = false; // becomes true if FTS5 virtual table is built successfully

    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // FS-F5 tier-C finding: without a busy_timeout a second gateway on the
    // same db file crashes with SQLITE_BUSY (database is locked) at boot.
    // 5000ms covers normal cross-process contention; single-writer-per-db
    // remains the deployment contract (docs/RUNBOOK.md).
    this.db.exec('PRAGMA busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chain_entries (
        seq INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);

    this._initFts();

    // Genesis (only if the entries table is empty).
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chain_entries').get();
    if (row.n === 0) {
      const cid = chainId ?? defaultChainId();
      const ts = genesisTs ?? Date.now();
      const prevHash = '0'.repeat(64);
      const payload = { type: 'genesis', chainId: cid };
      const hash = entryHash(0, prevHash, ts, payload);
      // FS-F5 tier-C: two processes booting on the same empty db race here —
      // INSERT OR IGNORE lets the winner's genesis stand; the loser re-reads
      // the canonical chainId below (both then serve the SAME chain).
      this.db
        .prepare(
          'INSERT OR IGNORE INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)'
        )
        .run(0, ts, prevHash, hash, JSON.stringify(payload));
      this.db
        .prepare('INSERT OR IGNORE INTO chain_meta(k, v) VALUES(?, ?)')
        .run('chainId', cid);
      this._insertFts(0, payload);
    }
    this.chainId = this._loadChainId();
  }

  _loadChainId() {
    const r = this.db.prepare('SELECT v FROM chain_meta WHERE k = ?').get('chainId');
    if (r && r.v) return r.v;
    // Derive from genesis payload as a fallback (defensive).
    const g = this.db
      .prepare('SELECT payload FROM chain_entries WHERE seq = 0')
      .get();
    if (g) {
      try {
        return JSON.parse(g.payload).chainId;
      } catch {
        return null;
      }
    }
    return null;
  }

  _initFts() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chain_fts USING fts5(
          payload, tool, bot,
          content='chain_entries', content_rowid='seq'
        );
        CREATE TRIGGER IF NOT EXISTS chain_fts_ai AFTER INSERT ON chain_entries BEGIN
          INSERT INTO chain_fts(rowid, payload, tool, bot)
          VALUES (new.seq, new.payload,
                  COALESCE(json_extract(new.payload, '$.tool'), ''),
                  COALESCE(json_extract(new.payload, '$.bot'),  ''));
        END;
        CREATE TRIGGER IF NOT EXISTS chain_fts_ad AFTER DELETE ON chain_entries BEGIN
          INSERT INTO chain_fts(chain_fts, rowid, payload, tool, bot)
          VALUES('delete', old.seq, old.payload,
                 COALESCE(json_extract(old.payload, '$.tool'), ''),
                 COALESCE(json_extract(old.payload, '$.bot'),  ''));
        END;
        CREATE TRIGGER IF NOT EXISTS chain_fts_au AFTER UPDATE ON chain_entries BEGIN
          INSERT INTO chain_fts(chain_fts, rowid, payload, tool, bot)
          VALUES('delete', old.seq, old.payload,
                 COALESCE(json_extract(old.payload, '$.tool'), ''),
                 COALESCE(json_extract(old.payload, '$.bot'),  ''));
          INSERT INTO chain_fts(rowid, payload, tool, bot)
          VALUES (new.seq, new.payload,
                  COALESCE(json_extract(new.payload, '$.tool'), ''),
                  COALESCE(json_extract(new.payload, '$.bot'),  ''));
        END;
      `);
      this.fts = true;
    } catch (e) {
      // FTS5 not available in this node:sqlite build — degrade gracefully.
      this.fts = false;
    }
  }

  _insertFts(seq, payload) {
    if (!this.fts) return;
    try {
      this.db
        .prepare(
          `INSERT INTO chain_fts(rowid, payload, tool, bot)
           VALUES (?, ?, COALESCE(?, ''), COALESCE(?, ''))`
        )
        .run(
          seq,
          JSON.stringify(payload),
          payload && typeof payload === 'object' ? payload.tool ?? null : null,
          payload && typeof payload === 'object' ? payload.bot ?? null : null
        );
    } catch {
      /* FTS is best-effort; the chain itself remains authoritative. */
    }
  }

  get head() {
    const row = this.db
      .prepare('SELECT seq, ts, prev_hash, hash, payload FROM chain_entries ORDER BY seq DESC LIMIT 1')
      .get();
    if (!row) return null;
    return this._rowToEntry(row);
  }

  get entries() {
    // Loads all rows. Acceptable at v2 scale (hundreds-to-thousands of entries).
    // Use since() to page; verify() re-hashes on demand.
    const rows = this.db
      .prepare('SELECT seq, ts, prev_hash, hash, payload FROM chain_entries ORDER BY seq ASC')
      .all();
    return rows.map((r) => this._rowToEntry(r));
  }

  get length() {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM chain_entries').get();
    return r.n;
  }

  append(payload, ts = Date.now()) {
    const prev = this.head;
    if (!prev) throw new Error('SqlChain: missing genesis; chain is empty');
    const seq = prev.seq + 1;
    // Hash the STORED (JSON-normalized) representation, not the live object:
    // undefined-valued keys vanish in JSON.stringify, so hashing pre-roundtrip
    // payloads makes verify() fail on reload. E2E-caught, 2026-09-02.
    const rt = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
    const hash = entryHash(seq, prev.hash, ts, rt);
    const stmt = this.db.prepare(
      'INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)'
    );
    stmt.run(seq, ts, prev.hash, hash, JSON.stringify(rt));
    this._insertFts(seq, rt);
    return { seq, prevHash: prev.hash, ts, payload: rt, hash };
  }

  since(seq) {
    const rows = this.db
      .prepare(
        'SELECT seq, ts, prev_hash, hash, payload FROM chain_entries WHERE seq > ? ORDER BY seq ASC'
      )
      .all(seq);
    return rows.map((r) => this._rowToEntry(r));
  }

  verify() {
    const rows = this.db
      .prepare('SELECT seq, ts, prev_hash, hash, payload FROM chain_entries ORDER BY seq ASC')
      .all();
    let prev = null;
    for (const row of rows) {
      const e = this._rowToEntry(row);
      if (e.seq !== (prev ? prev.seq + 1 : 0))
        return { ok: false, at: e.seq, reason: 'seq_gap', length: rows.length, chainId: this.chainId };
      if (!prev && e.prevHash !== '0'.repeat(64))
        return { ok: false, at: e.seq, reason: 'bad_genesis_prev', length: rows.length, chainId: this.chainId };
      if (prev && e.prevHash !== prev.hash)
        return { ok: false, at: e.seq, reason: 'prev_hash_mismatch', length: rows.length, chainId: this.chainId };
      const expected = entryHash(e.seq, e.prevHash, e.ts, e.payload);
      if (e.hash !== expected)
        return { ok: false, at: e.seq, reason: 'hash_mismatch', length: rows.length, chainId: this.chainId };
      prev = e;
    }
    return {
      ok: true,
      length: rows.length,
      head: prev ? prev.hash : null,
      chainId: this.chainId,
    };
  }

  _rowToEntry(row) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = { _raw: row.payload };
    }
    return {
      seq: row.seq,
      ts: row.ts,
      prevHash: row.prev_hash,
      hash: row.hash,
      payload,
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { SqlChain, entryHash, canonical };
