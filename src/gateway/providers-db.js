'use strict';
// FS-A4 phase 1 — providers store migration (pattern migration on ONE store).
//
// Two modes, selected by env at call time (never at module load, so tests can
// toggle per gateway instance):
//
//   TG_PROVIDERS_DB=1  →  getProviders(gw) returns a DB-backed registry on the
//       unified data/gateway.db (db.js single connection). On FIRST access the
//       existing data/providers.json is imported into a `providers` table
//       (fail closed on corrupt JSON, same as providers.js), after which all
//       reads and writes hit the DB — the JSON file is no longer touched.
//       Subsequent accesses/restarts load from the DB (JSON is NOT re-imported
//       while the table is non-empty).
//
//   env unset  →  getProviders(gw) simply re-exports the original
//       providers-singleton getRegistry — byte-identical legacy behaviour
//       (same WeakMap, same JSON file, same instance for a given gw).
//
// Consumers patch `require('../providers-singleton')` →
// `require('../providers-db')` and call getProviders(gw) instead of
// getRegistry(gw); the ProviderRegistry surface (list/models/get/plan/
// liveProbe) is unchanged, so mounts need no other edits.

const path = require('node:path');
const { db, tx, json } = require('./db');
const { ProviderRegistry, SEED } = require('./providers');
const { getRegistry } = require('./providers-singleton');

const DEFAULT_TABLE = 'providers';

class ProviderRegistryDb extends ProviderRegistry {
  /**
   * @param {object} opts
   * @param {string} [opts.file]      sqlite path (default data/gateway.db via db.js).
   * @param {string} [opts.jsonFile]  providers.json path to import from (default data/providers.json).
   * @param {string} [opts.table]     table name (default providers).
   * @param {Function} [opts.now]     clock override (tests).
   */
  constructor({ file, jsonFile, table = DEFAULT_TABLE, now } = {}) {
    // file: null → the base class never touches the JSON file; persistence is
    // overridden below to write to SQLite instead.
    super({ file: null, now });
    this.table = String(table);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table)) {
      throw new Error(`providers-db: invalid table name ${this.table}`);
    }
    this.jsonFile =
      jsonFile ?? path.join(process.cwd(), 'data', 'providers.json');
    this.db = db; // shared single connection from db.js
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        name TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this._loadOrImport();
  }

  // ── first access: import JSON → table, then read state from the DB ──
  _loadOrImport() {
    const count = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table}`)
      .get().n;
    if (count === 0) {
      this._importJson();
    }
    this._loadFromDb();
    // Persist the resolved state so the table is authoritative from now on
    // (also captures SEED-only state when there was no JSON to import).
    this._save();
  }

  _importJson() {
    const fs = require('node:fs');
    if (!fs.existsSync(this.jsonFile)) return; // nothing to import — SEED wins
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    } catch {
      throw new Error(
        'providers-db: providers.json unparseable — refusing to import (fail closed)'
      );
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers)) {
      throw new Error(
        'providers-db: providers.json must be {providers: [...]} — refusing to import (fail closed)'
      );
    }
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(name, record, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`
      );
      const ts = this.now();
      for (const p of raw.providers) {
        if (!p || typeof p.name !== 'string' || p.name.length === 0) {
          throw new Error(
            'providers-db: entry missing name — refusing to import (fail closed)'
          );
        }
        ins.run(p.name, json(p), ts);
      }
    });
  }

  _loadFromDb() {
    const rows = this.db
      .prepare(`SELECT name, record FROM ${this.table} ORDER BY name`)
      .all();
    if (rows.length > 0) {
      this.providers = new Map(); // DB is authoritative once it has rows
      for (const r of rows) {
        const p = JSON.parse(r.record);
        this.providers.set(p.name, {
          name: p.name,
          kind: p.kind || 'direct',
          baseUrl: p.baseUrl || null,
          models: Array.isArray(p.models) ? p.models.slice() : [],
          defaultModel: p.defaultModel || null,
          status: p.status || 'unknown',
          lastProbeAt: p.lastProbeAt || null,
          seededAt: p.seededAt || this.now(),
        });
      }
    }
    // SEED merge — identical to providers.js constructor semantics: SEED is
    // the source of truth for the SET, so entries missing from the DB are
    // added, and stale entries gain new models on upgrade.
    for (const p of SEED) {
      const cur = this.providers.get(p.name);
      if (!cur) {
        this.providers.set(p.name, {
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          models: p.models.slice(),
          defaultModel: p.defaultModel,
          status: 'unknown',
          lastProbeAt: null,
          seededAt: this.now(),
        });
        continue;
      }
      const merged = new Set(cur.models);
      for (const m of p.models) merged.add(m);
      cur.models = [...merged];
      if (!cur.defaultModel) cur.defaultModel = p.defaultModel;
    }
  }

  // ── persistence override: SQLite, transactional, no JSON touched ──
  _save() {
    tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(name, record, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`
      );
      const del = this.db.prepare(`DELETE FROM ${this.table} WHERE name = ?`);
      const keep = new Set();
      const ts = this.now();
      for (const p of this.providers.values()) {
        keep.add(p.name);
        ins.run(
          p.name,
          json({
            name: p.name,
            kind: p.kind,
            baseUrl: p.baseUrl,
            models: p.models,
            defaultModel: p.defaultModel,
            status: p.status,
            lastProbeAt: p.lastProbeAt,
            seededAt: p.seededAt,
          }),
          ts
        );
      }
      // Remove rows whose provider vanished from the map.
      for (const r of this.db
        .prepare(`SELECT name FROM ${this.table}`)
        .all()) {
        if (!keep.has(r.name)) del.run(r.name);
      }
    });
  }
}

// One DB-backed registry per gateway instance (WeakMap, like providers-singleton).
const dbRegistries = new WeakMap();

function getProviders(gw, opts = {}) {
  const dbMode =
    opts.force === 'db' ||
    (opts.force === undefined && process.env.TG_PROVIDERS_DB === '1');
  if (!dbMode) return getRegistry(gw); // env unset → byte-identical legacy
  let r = dbRegistries.get(gw);
  if (!r) {
    r = new ProviderRegistryDb(opts);
    dbRegistries.set(gw, r);
  }
  return r;
}

module.exports = { getProviders, getRegistry, ProviderRegistryDb };
