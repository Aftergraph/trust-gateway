'use strict';
// FS-E1 slice 1 — tenant foundation. Tenants are born in SQLite (no
// env-gated import phase): one `tenants` table on the shared db.js
// connection, plus per-tenant scoped data roots under <data>/tenants/<id>/.
//
//   create({name}) → { ok, id, record } — id is the slug of the name
//                    ([a-z0-9-], 3-24) with a collision-safe numeric suffix.
//   list() / get(id) / setDisabled(id, bool) — plain CRUD, DB authoritative
//                    on every call (no in-memory cache, so multi-process
//                    readers always agree).
//   ensureMain()   — the default 'main' tenant, auto-created, disabled=0.
//   dataRoot(id)   — mkdir-on-demand scoped dir; FAILS CLOSED on any id that
//                    is not a strict slug (no '/', no '..', no uppercase, no
//                    '.'): tenant ids are attacker-visible, so validation is
//                    containment, not convenience.
//
// getTenantStore(gw) is a WeakMap singleton per gateway (same pattern as
// users-db/providers-singleton) and bootstraps 'main' on first access.

const fs = require('node:fs');
const path = require('node:path');
const { db, tx } = require('./db');

const TABLE = 'tenants';
// Strict slug: lowercase letters/digits/dashes only, 3-24, no leading/trailing
// dash. This alone already excludes '/', '.', '..', and whitespace — the
// explicit checks in isValidTenantId are belt-and-braces fail-closed guards.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$|^[a-z0-9]{3}$/;
const SLUG_MAX = 24;
// Base slug is truncated so that even the widest collision suffix ('-99')
// keeps the id within SLUG_MAX.
const SLUG_BASE_MAX = SLUG_MAX - 3;

/** Fail-closed tenant-id validation: a strict slug or nothing. */
function isValidTenantId(id) {
  if (typeof id !== 'string') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  return SLUG_RE.test(id);
}

/** Name → slug base: lowercase, non-alphanumerics collapse to '-', trimmed. */
function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');
}

class TenantStore {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.now]    clock override (tests).
   * @param {string}   [opts.dataDir] scoped-data root (default TG_DATA_DIR env
   *                                or <cwd>/data, matching db.js resolution).
   */
  constructor({ now, dataDir } = {}) {
    this.db = db; // shared single connection from db.js
    this.now = now ?? (() => new Date().toISOString());
    this.dataDir = dataDir ?? process.env.TG_DATA_DIR ?? path.join(process.cwd(), 'data');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        disabled   INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /** Create a tenant; id = slug(name) with a collision-safe suffix. */
  create({ name }) {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'invalid_name' };
    const base = slugify(name);
    if (!isValidTenantId(base)) return { ok: false, error: 'invalid_name' };
    return tx(() => {
      const exists = (id) =>
        !!this.db.prepare(`SELECT 1 FROM ${TABLE} WHERE id = ?`).get(id);
      let id = base;
      if (exists(id)) {
        let placed = false;
        for (let n = 2; n <= 99; n++) {
          const cand = `${base}-${n}`;
          if (!exists(cand)) { id = cand; placed = true; break; }
        }
        if (!placed) return { ok: false, error: 'slug_exhausted' };
      }
      const record = { id, name, created_at: this.now(), disabled: false };
      this.db
        .prepare(`INSERT INTO ${TABLE}(id, name, created_at, disabled) VALUES(?, ?, ?, 0)`)
        .run(record.id, record.name, record.created_at);
      return { ok: true, id: record.id, record };
    });
  }

  /** All tenants, oldest first. */
  list() {
    return this.db
      .prepare(`SELECT id, name, created_at, disabled FROM ${TABLE} ORDER BY created_at, id`)
      .all()
      .map(_row);
  }

  /** One tenant or null. Never trusts a non-slug id. */
  get(id) {
    if (!isValidTenantId(id)) return null;
    return _row(this.db
      .prepare(`SELECT id, name, created_at, disabled FROM ${TABLE} WHERE id = ?`)
      .get(id));
  }

  /** Enable/disable; unknown tenant → { ok:false, error:'not_found' }. */
  setDisabled(id, flag) {
    const t = this.get(id);
    if (!t) return { ok: false, error: 'not_found' };
    this.db.prepare(`UPDATE ${TABLE} SET disabled = ? WHERE id = ?`).run(flag ? 1 : 0, t.id);
    return { ok: true, record: { ...t, disabled: !!flag } };
  }

  /** Default tenant: auto-created exactly once, never disabled by this path. */
  ensureMain() {
    const existing = this.get('main');
    if (existing) return existing;
    tx(() => {
      this.db
        .prepare(`INSERT OR IGNORE INTO ${TABLE}(id, name, created_at, disabled) VALUES('main', 'Main', ?, 0)`)
        .run(this.now());
    });
    return this.get('main');
  }

  /**
   * Scoped per-tenant data root: <dataDir>/tenants/<id>/ — created on demand.
   * Throws (fail closed) on any id that could escape the base directory.
   */
  dataRoot(id) {
    if (!isValidTenantId(id)) {
      throw new Error('tenants: invalid tenant id (fail closed)');
    }
    const base = path.join(this.dataDir, 'tenants');
    const root = path.resolve(path.join(base, id));
    // Containment proof, independent of the regex above.
    if (root !== base && !root.startsWith(base + path.sep)) {
      throw new Error('tenants: tenant id escapes data root (fail closed)');
    }
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
}

function _row(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, created_at: r.created_at, disabled: !!r.disabled };
}

// One store per gateway instance (WeakMap, like users-db / providers-singleton).
const stores = new WeakMap();

/** WeakMap-cached TenantStore for this gateway; bootstraps 'main' on first use. */
function getTenantStore(gw, opts = {}) {
  let s = stores.get(gw);
  if (!s) {
    s = new TenantStore(opts);
    s.ensureMain();
    stores.set(gw, s);
  }
  return s;
}

module.exports = { TenantStore, getTenantStore, isValidTenantId, slugify, TABLE, SLUG_RE };
