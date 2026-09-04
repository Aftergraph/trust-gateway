'use strict';
// FS-I3 — per-tenant quotas: disk + API caps, enforced FAIL CLOSED.
//
// Table `tenant_quotas` (created in db.js open(), belt-and-braces here too):
//   tenant TEXT PRIMARY KEY, max_disk_mb INTEGER, max_api_per_hour INTEGER,
//   updated_at INTEGER NOT NULL. A missing row → env-configurable defaults:
//   TG_TENANT_DEFAULT_DISK_MB (500), TG_TENANT_DEFAULT_API_PER_HOUR (1000).
//
//   getQuota(tenant) → {maxDiskMb, maxApiPerHour}   row over defaults
//   setQuota(tenant, patch) → {ok, record}          null resets to default
//   checkDisk(tenant, store?) → {ok, usedMb, limitMb}
//       du-shim over <dataDir>/tenants/<tenant>/ — strictly READ-ONLY walk
//       (never mkdirs: a quota check must not mutate tenant state; the
//       main-tenant "no tenant dirs created" guarantee is preserved).
//   checkApi(tenant) → {ok, count, limit}
//       kv_store key 'quota:api:<tenant>:<hourBucket>', atomic increment
//       inside tx() (BEGIN IMMEDIATE serializes writers); stale buckets for
//       the same tenant are pruned on each increment.
//   peekApi(tenant) → count                         read-only, no increment
//
// Fail-closed: every method validates the tenant id (strict slug) and lets
// errors propagate — the middleware in tenant-scope.js turns any error into
// a denial, never an allowance.

const fs = require('node:fs');
const path = require('node:path');
const { db, tx, json, unjson } = require('./db');
const { isValidTenantId } = require('./tenants');

const TABLE = 'tenant_quotas';
const KV_API_PREFIX = 'quota:api:';
const HOUR_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

function _intEnv(name, dflt) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : dflt;
}

/** Env-configurable default caps, read per call (tests flip env freely). */
function defaultQuota() {
  return {
    maxDiskMb: _intEnv('TG_TENANT_DEFAULT_DISK_MB', 500),
    maxApiPerHour: _intEnv('TG_TENANT_DEFAULT_API_PER_HOUR', 1000),
  };
}

function hourBucket(now = Date.now()) {
  return Math.floor(now / HOUR_MS);
}

function apiBucketKey(tenant, bucket) {
  return `${KV_API_PREFIX}${tenant}:${bucket}`;
}

/** Integer ≥ 0, or null (explicit reset to default). Anything else → throw. */
function _capOrNull(v, field) {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error(`tenant-quotas: invalid ${field} (fail closed)`);
    err.code = 'invalid_quota';
    throw err;
  }
  return n;
}

class TenantQuotas {
  /**
   * @param {object} [opts]
   * @param {import('node:sqlite').DatabaseSync} [opts.db] Override connection (tests).
   */
  constructor({ db: dbh = db } = {}) {
    this.db = dbh;
    // Normally created in db.js open(); direct construction still works.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        tenant           TEXT PRIMARY KEY,
        max_disk_mb      INTEGER,
        max_api_per_hour INTEGER,
        updated_at       INTEGER NOT NULL
      );
    `);
  }

  _checkId(tenant) {
    if (!isValidTenantId(tenant)) {
      throw new Error('tenant-quotas: invalid tenant id (fail closed)');
    }
  }

  /** True when an explicit quota row exists for the tenant. */
  hasStoredRow(tenant) {
    this._checkId(tenant);
    return !!this.db
      .prepare(`SELECT 1 FROM ${TABLE} WHERE tenant = ?`)
      .get(tenant);
  }

  /** Effective caps for a tenant: stored row over env defaults. */
  getQuota(tenant) {
    this._checkId(tenant);
    const row = this.db
      .prepare(`SELECT max_disk_mb, max_api_per_hour FROM ${TABLE} WHERE tenant = ?`)
      .get(tenant);
    const d = defaultQuota();
    return {
      maxDiskMb: row && row.max_disk_mb !== null && row.max_disk_mb !== undefined
        ? row.max_disk_mb
        : d.maxDiskMb,
      maxApiPerHour: row && row.max_api_per_hour !== null && row.max_api_per_hour !== undefined
        ? row.max_api_per_hour
        : d.maxApiPerHour,
    };
  }

  /**
   * Upsert caps. Patch keys may be null to reset to the default.
   * Unknown patch keys are ignored; invalid values throw (fail closed).
   */
  setQuota(tenant, patch = {}) {
    this._checkId(tenant);
    // Preserve the stored column for any key the patch leaves undefined
    // (undefined → keep, null → explicit reset to default, number → set).
    const stored = this.db
      .prepare(`SELECT max_disk_mb, max_api_per_hour FROM ${TABLE} WHERE tenant = ?`)
      .get(tenant);
    const nextDisk = patch.maxDiskMb !== undefined
      ? _capOrNull(patch.maxDiskMb, 'maxDiskMb')
      : (stored ? stored.max_disk_mb : null);
    const nextApi = patch.maxApiPerHour !== undefined
      ? _capOrNull(patch.maxApiPerHour, 'maxApiPerHour')
      : (stored ? stored.max_api_per_hour : null);
    const updated = Date.now();
    return tx(() => {
      this.db
        .prepare(
          `INSERT INTO ${TABLE}(tenant, max_disk_mb, max_api_per_hour, updated_at)
           VALUES(?, ?, ?, ?)
           ON CONFLICT(tenant) DO UPDATE SET
             max_disk_mb = excluded.max_disk_mb,
             max_api_per_hour = excluded.max_api_per_hour,
             updated_at = excluded.updated_at`
        )
        .run(tenant, nextDisk, nextApi, updated);
      return {
        ok: true,
        record: { tenant, ...this.getQuota(tenant), updated_at: updated },
      };
    });
  }

  /**
   * READ-ONLY du-shim: total bytes under <dataDir>/tenants/<tenant>/.
   * Never creates directories and never mutates anything; a missing tenant
   * dir is 0 bytes. Throws on invalid ids / walk errors (fail closed).
   */
  diskUsageBytes(tenant, store) {
    this._checkId(tenant);
    const base = path.resolve((store && store.dataDir) || process.env.TG_DATA_DIR || path.join(process.cwd(), 'data'), 'tenants');
    const root = path.resolve(path.join(base, tenant));
    if (root !== base && !root.startsWith(base + path.sep)) {
      throw new Error('tenant-quotas: tenant id escapes data root (fail closed)');
    }
    let st;
    try {
      st = fs.statSync(root);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        // ENOTDIR here means the path exists as a FILE — that is a real
        // storage-layout error, not an empty tenant: fail closed.
        if (err.code === 'ENOENT') return 0;
      }
      throw err;
    }
    if (!st.isDirectory()) {
      throw new Error('tenant-quotas: tenant data root is not a directory (fail closed)');
    }
    let total = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
        // symlinks/others: not counted (never followed — no escapes)
      }
    };
    walk(root);
    return total;
  }

  /**
   * Disk check. ok = used < limit (strictly under cap).
   * @param {string} tenant strict slug
   * @param {object} [store] TenantStore (for its dataDir); optional
   */
  checkDisk(tenant, store) {
    this._checkId(tenant);
    const { maxDiskMb } = this.getQuota(tenant);
    const bytes = this.diskUsageBytes(tenant, store);
    const usedMb = Math.round((bytes / MB) * 100) / 100;
    return { ok: bytes < maxDiskMb * MB, usedMb, limitMb: maxDiskMb };
  }

  /**
   * Atomic per-hour API check: increments the bucket, prunes stale buckets
   * for this tenant, and allows while count ≤ limit.
   */
  checkApi(tenant, { now = Date.now() } = {}) {
    this._checkId(tenant);
    const { maxApiPerHour } = this.getQuota(tenant);
    const key = apiBucketKey(tenant, hourBucket(now));
    const count = tx(() => {
      const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
      const next = (row ? (Number(unjson(row.value)) || 0) : 0) + 1;
      this.db
        .prepare(
          `INSERT INTO kv_store(key, value, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(key, json(next), now);
      // Tenant ids are strict slugs (no % _ \), so this LIKE is literal.
      this.db
        .prepare(`DELETE FROM kv_store WHERE key LIKE ? AND key <> ?`)
        .run(`${KV_API_PREFIX}${tenant}:%`, key);
      return next;
    });
    return { ok: count <= maxApiPerHour, count, limit: maxApiPerHour };
  }

  /** Current bucket count WITHOUT incrementing (operator GET usage view). */
  peekApi(tenant, { now = Date.now() } = {}) {
    this._checkId(tenant);
    const row = this.db
      .prepare('SELECT value FROM kv_store WHERE key = ?')
      .get(apiBucketKey(tenant, hourBucket(now)));
    return row ? (Number(unjson(row.value)) || 0) : 0;
  }
}

// One quota store per gateway instance (WeakMap, same pattern as tenants.js).
const singletons = new WeakMap();

/** WeakMap-cached TenantQuotas for this gateway. */
function getTenantQuotas(gw, opts = {}) {
  let q = singletons.get(gw);
  if (!q) {
    q = new TenantQuotas(opts);
    singletons.set(gw, q);
  }
  return q;
}

module.exports = { TenantQuotas, getTenantQuotas, defaultQuota, hourBucket, TABLE, KV_API_PREFIX };
