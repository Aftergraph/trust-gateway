'use strict';
// FS-O3 — operator dashboard aggregate.
//
// dashboard(gw) → {generatedAt, sections: {tenants, skills, apikeys,
// federated, secrets, audit, quotas, rateBuckets}} — pulls scalar
// counts from each module's existing public methods. Read-only, no
// side effects, fail-open per section (a missing table returns null,
// never throws).
//
// Inert (returns null) when TG_OPERATOR_DASHBOARD unset.

function enabled() {
  return process.env.TG_OPERATOR_DASHBOARD === '1';
}

function _safe(fn) {
  try { return fn(); } catch { return null; }
}

function build() {
  if (!enabled()) return null;
  const sections = {};

  // Tenants
  sections.tenants = _safe(() => {
    const { getTenantStore } = require('./tenants');
    const all = getTenantStore().list();
    return { total: all.length, disabled: all.filter(t => t.disabled).length };
  });

  // Skills
  sections.skills = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM skills`).get()?.n || 0;
    return { total };
  });

  // API keys
  sections.apikeys = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM api_keys`).get()?.n || 0;
    return { total };
  });

  // Federated (FS-G1)
  sections.federated = _safe(() => {
    const { getFedRunLedger } = require('./skills-federation');
    return { tableReady: !!getFedRunLedger() };
  });

  // Secrets
  sections.secrets = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tenant_secrets`).get()?.n || 0;
    return { total };
  });

  // Audit chain
  sections.audit = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_chain`).get()?.n || 0;
    return { total };
  });

  // Quotas
  sections.quotas = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tenant_quotas`).get()?.n || 0;
    return { tenantsWithQuota: total };
  });

  // Rate buckets
  sections.rateBuckets = _safe(() => {
    const { db } = require('./db');
    const total = db.prepare(`SELECT COUNT(DISTINCT bucket_key) AS n FROM rate_buckets`).get()?.n || 0;
    return { activeBuckets: total };
  });

  return {
    generatedAt: Date.now(),
    sections,
  };
}

module.exports = { enabled, build };
