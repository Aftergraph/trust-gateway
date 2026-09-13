'use strict';

const path = require('node:path');
const { createAdapterRuntime } = require('./adapter-runtime');
const { revalidate } = require('./aie-client');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isEnabled(env) {
  return env?.TG_ADAPTER_RUNTIME === '1';
}

function positiveInteger(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw fail('adapter_runtime_' + name.toLowerCase() + '_invalid');
  }
  return value;
}

function transportOptions(env) {
  return {
    maxRequestBytes: positiveInteger(env, 'TG_ADAPTER_MAX_REQUEST_BYTES', 1024 * 1024),
    maxResponseBytes: positiveInteger(env, 'TG_ADAPTER_MAX_RESPONSE_BYTES', 1024 * 1024),
    timeoutMs: positiveInteger(env, 'TG_ADAPTER_TIMEOUT_MS', 10_000),
  };
}

function loadGovernanceModule(env, override) {
  if (override !== undefined) return override;
  const spec = String(env?.TG_ADAPTER_GOVERNANCE_MODULE || '').trim();
  if (!spec) throw fail('adapter_runtime_governance_module_required');
  try {
    return require(path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec));
  } catch {
    throw fail('adapter_runtime_governance_module_unavailable');
  }
}

function alignDatabaseFile(env, dbmod) {
  // bin/gateway.js historically exposes DB_FILE while the shared stores use
  // TG_DB_FILE. When production binding is enabled, make both layers use the
  // same file before the first store access.
  if (env !== process.env || env.TG_DB_FILE || !env.DB_FILE) return;
  env.TG_DB_FILE = env.DB_FILE;
  dbmod.closeDb();
  dbmod.resetDb();
}

function buildStorage(env, overrides = {}) {
  // Keep SQLite and tenant/secret modules out of import-time test discovery.
  // They are intentionally loaded only after explicit production activation.
  const { TenantStore } = require('./tenants');
  const { SecretsVault } = require('./secrets-vault');
  const { CredentialHandleStore } = require('./credential-handles');
  const dbmod = require('./db');
  alignDatabaseFile(env, dbmod);
  if (overrides.vault && overrides.handles && overrides.tenantStore) {
    return {
      vault: overrides.vault,
      handles: overrides.handles,
      tenantStore: overrides.tenantStore,
    };
  }

  const master = String(env?.TG_SECRETS_MASTER_KEY || '');
  if (!master) throw fail('adapter_runtime_master_key_required');

  const tenantStore = new TenantStore({
    dataDir: env?.TG_DATA_DIR || path.join(process.cwd(), 'data'),
  });
  tenantStore.ensureMain();

  const vault = new SecretsVault({ db: dbmod.db, enabled: true, master });
  const handles = new CredentialHandleStore({ db: dbmod.db, vault });
  return { vault, handles, tenantStore };
}

function validateDestinationPolicy(policy) {
  if (!Array.isArray(policy) || policy.length === 0) {
    throw fail('adapter_runtime_destination_policy_required');
  }
  for (const rule of policy) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        typeof rule.host !== 'string' || !rule.host.trim() ||
        !Array.isArray(rule.schemes) || rule.schemes.length === 0 ||
        !Array.isArray(rule.ports) || rule.ports.length === 0 ||
        !Array.isArray(rule.methods) || rule.methods.length === 0 ||
        !Array.isArray(rule.pathPrefixes) || rule.pathPrefixes.length === 0 ||
        rule.ports.some((port) => !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) ||
        rule.pathPrefixes.some((prefix) => typeof prefix !== 'string' || !prefix.startsWith('/'))) {
      throw fail('adapter_runtime_destination_policy_invalid');
    }
  }
  return policy;
}

function createProductionAdapterRuntime({
  env = process.env,
  audit,
  now = () => Date.now(),
  governanceModule,
  storage,
  transportOptions: customTransportOptions,
} = {}) {
  if (!isEnabled(env)) return null;
  if (typeof audit !== 'function') throw fail('adapter_runtime_audit_required');

  const loaded = loadGovernanceModule(env, governanceModule);
  const factory = loaded && typeof loaded.createAdapterGovernance === 'function'
    ? loaded.createAdapterGovernance
    : null;
  if (!factory) throw fail('adapter_runtime_governance_factory_required');

  let governance;
  try {
    governance = factory({
      env,
      now,
      audit,
      aie: { revalidate },
    });
  } catch {
    throw fail('adapter_runtime_governance_factory_failed');
  }
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    throw fail('adapter_runtime_governance_invalid');
  }

  for (const name of [
    'adapterContextResolver',
    'authorityCheck',
    'approvalCheck',
    'credentialInjector',
    'commitGuard',
  ]) {
    if (typeof governance[name] !== 'function') {
      const codeName = name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      throw fail('adapter_runtime_' + codeName + '_required');
    }
  }
  if (governance.transport !== undefined) {
    throw fail('adapter_runtime_custom_transport_forbidden');
  }

  const stores = buildStorage(env, storage);
  return createAdapterRuntime({
    ...stores,
    adapterContextResolver: governance.adapterContextResolver,
    authorityCheck: governance.authorityCheck,
    approvalCheck: governance.approvalCheck,
    destinationPolicy: validateDestinationPolicy(governance.destinationPolicy),
    credentialInjector: governance.credentialInjector,
    commitGuard: governance.commitGuard,
    audit,
    now,
    transportOptions: customTransportOptions || governance.transportOptions || transportOptions(env),
  });
}

module.exports = { createProductionAdapterRuntime, isEnabled };
