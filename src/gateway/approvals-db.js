'use strict';
// FS-A5 phase 2 — approvals store migration (SQLite unification).
//
// Two modes, selected by env at call time (never at module load, so tests can
// toggle per gateway instance):
//
//   TG_APPROVALS_DB=1  →  getApprovals(gw) returns a DB-backed ApprovalStore
//       on the unified data/gateway.db (db.js single connection). On FIRST
//       access the existing data/approvals.json is imported into an
//       `approvals` table (fail closed on corrupt/malformed JSON, same as
//       approvals.js), after which all reads and writes hit the DB — the JSON
//       file is no longer touched. Subsequent accesses/restarts load from the
//       DB (JSON is NOT re-imported while the table is non-empty). Pending
//       approvals survive restart exactly like the JSON path.
//
//   env unset  →  getApprovals(gw) re-exports the legacy JSON-backed
//       ApprovalStore — byte-identical legacy behaviour, cached per gateway
//       in a WeakMap so repeated calls return the SAME instance.
//
// SECRET SCRUBBING PRESERVED: resolved/expired approvals NEVER carry raw args
// — the scrub happens at the single persistence point (_save) before anything
// is written to the DB, so the args_json column stays NULL for every
// non-pending row (same guarantee as the JSON path scrubbing on save).

const path = require('node:path');
const { db, tx, json } = require('./db');
const { ApprovalStore } = require('./approvals');

const DEFAULT_TABLE = 'approvals';

class ApprovalStoreDb extends ApprovalStore {
  /**
   * @param {object} opts
   * @param {string} [opts.jsonFile] approvals.json path to import from
   *                                  (default data/approvals.json).
   * @param {string} [opts.table]    table name (default approvals).
   * @param {Function} [opts.now]    clock override (tests).
   * @param {number} [opts.ttlMs]    pending-TTL override.
   * @param {object} [opts.gw]       gateway (impact computation context).
   * @param {Function} [opts.computeImpactFn] impact override (tests).
   */
  constructor({ jsonFile, table = DEFAULT_TABLE, now, ttlMs, gw, computeImpactFn } = {}) {
    // file: null → the base class never touches the JSON file; persistence is
    // overridden below to write to SQLite instead.
    super({ ttlMs, now, file: null, gw, computeImpactFn });
    this.table = String(table);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table)) {
      throw new Error(`approvals-db: invalid table name ${this.table}`);
    }
    this.jsonFile = jsonFile ?? path.join(process.cwd(), 'data', 'approvals.json');
    this.db = db; // shared single connection from db.js
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id                TEXT PRIMARY KEY,
        bot               TEXT,
        tool              TEXT,
        args_json         TEXT,
        status            TEXT NOT NULL,
        requested_by      TEXT,
        resolved_by       TEXT,
        created_at        INTEGER NOT NULL,
        resolved_at       INTEGER,
        args_summary_json TEXT,
        reason            TEXT,
        expires_at        INTEGER,
        impact_json       TEXT
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
    this.sweep(); // expired pending entries fail closed on load (same as _load)
    this._save(); // persist the swept state; table is authoritative from now on
  }

  _importJson() {
    const fs = require('node:fs');
    if (!fs.existsSync(this.jsonFile)) return; // nothing to import — fresh install
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    } catch {
      throw new Error('approvals: file unparseable — refusing to load (fail closed)');
    }
    if (!Array.isArray(arr)) throw new Error('approvals: file must be a JSON array');
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(id, bot, tool, args_json, status, requested_by,
                                   resolved_by, created_at, resolved_at,
                                   args_summary_json, reason, expires_at, impact_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           bot = excluded.bot, tool = excluded.tool, args_json = excluded.args_json,
           status = excluded.status, requested_by = excluded.requested_by,
           resolved_by = excluded.resolved_by, created_at = excluded.created_at,
           resolved_at = excluded.resolved_at,
           args_summary_json = excluded.args_summary_json, reason = excluded.reason,
           expires_at = excluded.expires_at, impact_json = excluded.impact_json`
      );
      for (const r of arr) {
        // Identical validation to approvals.js _load — fail closed.
        if (!r || typeof r.id !== 'string') throw new Error('approvals: entry missing id');
        ins.run(
          r.id,
          r.bot ?? null,
          r.tool ?? null,
          r.status === 'pending' ? json(r.args) : null, // scrub before persist, always
          r.status,
          r.bot ?? null,
          r.resolvedBy ?? null,
          r.createdAt,
          r.resolvedAt ?? null,
          r.status === 'pending' ? json(r.argsSummary) : null,
          r.reason ?? null,
          r.expiresAt ?? null,
          json(r.impact)
        );
      }
    });
  }

  _loadFromDb() {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.table} ORDER BY created_at, id`)
      .all();
    this.requests = new Map(); // DB is authoritative once we get here
    this._next = 1;
    for (const r of rows) {
      this.requests.set(r.id, {
        id: r.id,
        bot: r.bot,
        tool: r.tool,
        args: r.args_json === null ? undefined : JSON.parse(r.args_json),
        argsSummary: r.args_summary_json === null ? null : JSON.parse(r.args_summary_json),
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at,
        impact: r.impact_json === null ? undefined : JSON.parse(r.impact_json),
      });
      // Preserve the id counter across restarts (same rule as approvals.js).
      const n = Number(String(r.id).replace(/^apr_/, ''));
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  // ── persistence override: SQLite, transactional, no JSON touched ──
  // THE scrub point: args / argsSummary are persisted ONLY for pending rows.
  // Resolved and expired rows store NULL in both columns — a DB leak can no
  // more replay a resolved approval's secrets than a JSON leak could.
  _save() {
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(id, bot, tool, args_json, status, requested_by,
                                   resolved_by, created_at, resolved_at,
                                   args_summary_json, reason, expires_at, impact_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           bot = excluded.bot, tool = excluded.tool, args_json = excluded.args_json,
           status = excluded.status, requested_by = excluded.requested_by,
           resolved_by = excluded.resolved_by, created_at = excluded.created_at,
           resolved_at = excluded.resolved_at,
           args_summary_json = excluded.args_summary_json, reason = excluded.reason,
           expires_at = excluded.expires_at, impact_json = excluded.impact_json`
      );
      const del = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);
      const keep = new Set();
      for (const r of this.requests.values()) {
        keep.add(r.id);
        const pending = r.status === 'pending';
        ins.run(
          r.id,
          r.bot ?? null,
          r.tool ?? null,
          pending ? json(r.args) : null, // scrub secrets from resolved/expired
          r.status,
          r.bot ?? null,
          r.resolvedBy ?? null,
          r.createdAt,
          r.resolvedAt ?? null,
          pending ? json(r.argsSummary) : null,
          r.reason ?? null,
          r.expiresAt ?? null,
          json(r.impact)
        );
      }
      // Remove rows whose request vanished from the map.
      for (const row of this.db
        .prepare(`SELECT id FROM ${this.table}`)
        .all()) {
        if (!keep.has(row.id)) del.run(row.id);
      }
    });
  }
}

// One store per gateway instance (WeakMap, like providers-singleton) — for
// BOTH modes, so getApprovals(gw) === getApprovals(gw) always.
const stores = new WeakMap();

function getApprovals(gw, opts = {}) {
  const dbMode =
    opts.force === 'db' ||
    (opts.force === undefined && process.env.TG_APPROVALS_DB === '1');
  let s = stores.get(gw);
  if (!s) {
    if (dbMode) {
      // In DB mode a legacy-style `file` option is the import source.
      s = new ApprovalStoreDb({ ...opts, jsonFile: opts.jsonFile ?? opts.file });
    } else {
      // Byte-identical legacy: same construction as server.js.
      s = new ApprovalStore({
        ttlMs: opts.ttlMs,
        now: opts.now,
        file: opts.file ?? null,
        gw: opts.gw ?? gw,
        computeImpactFn: opts.computeImpactFn,
      });
    }
    stores.set(gw, s);
  }
  return s;
}

module.exports = { getApprovals, ApprovalStoreDb, DEFAULT_TABLE };