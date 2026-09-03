'use strict';
// FS-E1 slice 2 — tenant-scoped store paths.
//
// scopeDir(store, gw, tenantId, kind) → data/tenants/<tenantId>/<kind>/
// for kind ∈ {audit, approvals, memory, artifacts, backups}. mkdir-on-demand;
// reuses TenantStore.dataRoot, which validates the id (strict slug) and
// proves containment against the scoped-data root — bad ids FAIL CLOSED by
// throwing, never by best-effort sanitizing (tenant ids are attacker-visible).
//
// scopedStore(gw, key, make) — WeakMap cache of per-tenant store instances so
// one gateway process serving several tenants keeps exactly one store (and
// therefore one durable file) per tenant per store kind.
//
// tenantAuditTag(tenant) → {} for main (byte-identical chain payloads) or
// { tenant: <id> } for any other tenant, so the audit chain carries a
// tenant-visible tag that /v2/search can scope on. Tags never contain token
// material or other secrets.

const fs = require('node:fs');
const path = require('node:path');
const { getTenantStore, isValidTenantId } = require('./tenants');

const KINDS = Object.freeze(['audit', 'approvals', 'memory', 'artifacts', 'backups']);
const KIND_SET = new Set(KINDS);

/**
 * Tenant-scoped directory for one store kind:
 *   <dataDir>/tenants/<tenantId>/<kind>/  — created on demand.
 * @param {TenantStore|null} store  existing TenantStore (else getTenantStore(gw))
 * @param {object|null}      gw     gateway instance (used only when store is null)
 * @param {string}           tenantId strict slug
 * @param {string}           kind   one of KINDS
 * @returns {string} absolute scoped dir
 */
function scopeDir(store, gw, tenantId, kind) {
  if (!KIND_SET.has(kind)) {
    throw new Error('tenant-scope: unknown kind (fail closed)');
  }
  if (!isValidTenantId(tenantId)) {
    throw new Error('tenant-scope: invalid tenant id (fail closed)');
  }
  const ts = store ?? getTenantStore(gw);
  const root = ts.dataRoot(tenantId); // mkdir-on-demand + containment proof
  const dir = path.resolve(path.join(root, kind));
  // Containment proof, independent of dataRoot's own check.
  const base = path.resolve(ts.dataDir, 'tenants');
  if (!dir.startsWith(base + path.sep)) {
    throw new Error('tenant-scope: kind dir escapes data root (fail closed)');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// gw -> Map(key -> store instance)
const caches = new WeakMap();

/** WeakMap-cached per-gateway, per-key store factory (same pattern as the
 *  singletons in memory.js / artifacts.js, keyed one level deeper). */
function scopedStore(gw, key, make) {
  if (!gw) throw new Error('tenant-scope: gw required for scopedStore');
  let m = caches.get(gw);
  if (!m) {
    m = new Map();
    caches.set(gw, m);
  }
  let s = m.get(key);
  if (!s) {
    s = make();
    m.set(key, s);
  }
  return s;
}

/**
 * Extra audit-payload fields for a tenant-resolved request: main tenant
 * chains stay byte-identical ({}); other tenants get an explicit tag.
 *
 * FS-G1: opts.federatedFrom — when a cross-tenant federation run is
 * audited, the owner-tenant id rides the SAME row: for a non-main running
 * tenant the returned object gains `federatedFrom: <owner-tenant-id>` on
 * top of `tenant`; for a MAIN running tenant `{}` shape is preserved, so
 * the caller adds the field itself (see 105-skills.js) — the existing
 * tag function's shape for non-federated runs never changes.
 */
function tenantAuditTag(tenant, opts = {}) {
  const base = !tenant || tenant.id === 'main' ? {} : { tenant: tenant.id };
  if (opts && opts.federatedFrom && base.tenant) {
    return { ...base, federatedFrom: opts.federatedFrom };
  }
  return base;
}

module.exports = { scopeDir, scopedStore, tenantAuditTag, KINDS };
