'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AdapterCredentialLifecycle, adapterCredentialKey } = require('../src/gateway/adapter-credentials');

function tenantStore(overrides = {}) {
  return { get(id) { return overrides[id] || (id === 'tenant_a' || id === 'tenant_b' ? { id, disabled: false } : null); } };
}

function vault(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    setSecret(tenant, key, value) { calls.push(['setSecret', tenant, key]); values.set(tenant + '/' + key, value); return true; },
    listKeys(tenant) { return [...values.keys()].filter((key) => key.startsWith(tenant + '/')).map((key) => key.slice(tenant.length + 1)); },
    getSecret(tenant, key) { calls.push(['getSecret', tenant, key]); return values.get(tenant + '/' + key) || null; },
  };
}

function handles(meta = {}) {
  const calls = [];
  return {
    calls,
    issue(input) {
      calls.push(['issue', input]);
      return { handleId: 'ch_adapter_test', tenant: input.tenant, principalId: input.principalId, missionId: input.missionId, authorityRef: input.authorityRef, purpose: input.purpose, credentialClass: input.credentialClass, allowedDestinations: input.allowedDestinations, allowedMethods: input.allowedMethods, allowedPathPrefixes: input.allowedPathPrefixes, scopeRefs: input.scopeRefs, issuedAt: 1000, expiresAt: input.expiresAt, revokedAt: null, revokedReason: null };
    },
    inspect() {
      return { tenant: 'tenant_a', principalId: 'principal_1', missionId: 'mission_1', authorityRef: 'authority_1', purpose: 'adapter_probe', credentialClass: 'api_token', allowedDestinations: ['api.example.test'], allowedMethods: ['GET'], allowedPathPrefixes: ['/v1'], scopeRefs: ['adapter:adp_0001'], issuedAt: 1000, expiresAt: 2000, revokedAt: null, revokedReason: null, ...meta };
    },
    revoke(handleId, reason) { calls.push(['revoke', handleId, reason]); return { ...this.inspect(), revokedAt: 1500, revokedReason: reason }; },
    resolveForBroker(handleId, request) { calls.push(['resolveForBroker', handleId, request]); return { ...this.inspect(), secretKey: adapterCredentialKey('adp_0001', 'token'), secret: 'runtime-only' }; },
  };
}

function input(overrides = {}) {
  return { tenant: 'tenant_a', adapterId: 'adp_0001', secretName: 'token', principalId: 'principal_1', missionId: 'mission_1', authorityRef: 'authority_1', purpose: 'adapter_probe', credentialClass: 'api_token', allowedDestinations: ['api.example.test'], allowedMethods: ['GET'], allowedPathPrefixes: ['/v1'], scopeRefs: ['mission:mission_1'], expiresAt: 2000, ...overrides };
}

function makeLifecycle(v = vault({ 'tenant_a/adapters/adp_0001/credentials/token': 'runtime-secret-1' }), h = handles(), t = tenantStore()) {
  return { lifecycle: new AdapterCredentialLifecycle({ vault: v, handles: h, tenantStore: t }), vault: v, handles: h };
}

test('canonical adapter credential keys are tenant-safe and secret-free', () => {
  assert.equal(adapterCredentialKey('adp_0001', 'Token'), 'adapters/adp_0001/credentials/token');
  assert.throws(() => adapterCredentialKey('../escape', 'token'), { code: 'adapter_credential_identifier_invalid' });
  assert.throws(() => adapterCredentialKey('adp_0001', '../token'), { code: 'adapter_credential_identifier_invalid' });
});

test('stores an adapter secret in Vault without returning its value', () => {
  const { lifecycle, vault: v } = makeLifecycle(vault());
  const result = lifecycle.setSecret({ tenant: 'tenant_a', adapterId: 'adp_0001', secretName: 'Token', value: 'runtime-secret-1' });
  assert.deepEqual(result, { ok: true, tenant: 'tenant_a', adapterId: 'adp_0001', secretName: 'token' });
  assert.deepEqual(v.calls, [['setSecret', 'tenant_a', 'adapters/adp_0001/credentials/token']]);
  assert.equal(JSON.stringify(result).includes('runtime-secret-1'), false);
});

test('refuses writes and issuance for unknown or disabled tenants', () => {
  const disabled = tenantStore({ tenant_a: { id: 'tenant_a', disabled: true } });
  const { lifecycle } = makeLifecycle(vault(), handles(), disabled);
  assert.throws(() => lifecycle.setSecret({ tenant: 'tenant_a', adapterId: 'adp_0001', secretName: 'token', value: 'x' }), { code: 'adapter_credential_tenant_unavailable' });
  assert.throws(() => lifecycle.issueHandle(input({ tenant: 'unknown' })), { code: 'adapter_credential_tenant_unavailable' });
});

test('issues an opaque adapter handle with a mandatory adapter scope', () => {
  const h = handles();
  const { lifecycle } = makeLifecycle(undefined, h);
  const result = lifecycle.issueHandle(input());
  const issue = h.calls.find((call) => call[0] === 'issue')[1];
  assert.equal(result.handleId, 'ch_adapter_test');
  assert.equal(result.adapterId, 'adp_0001');
  assert.equal(result.secretName, 'token');
  assert.deepEqual(issue.scopeRefs, ['adapter:adp_0001', 'mission:mission_1']);
  assert.equal(issue.secretKey, 'adapters/adp_0001/credentials/token');
  assert.equal('secret' in result, false);
  assert.equal('secretKey' in result, false);
  assert.equal(JSON.stringify(result).includes('runtime-secret-1'), false);
});

test('refuses issuance when the tenant-scoped Vault key is absent', () => {
  const { lifecycle, handles: h } = makeLifecycle(vault(), handles());
  assert.throws(() => lifecycle.issueHandle(input()), { code: 'adapter_credential_secret_missing' });
  assert.equal(h.calls.some((call) => call[0] === 'issue'), false);
});

test('enforces tenant and adapter binding before inspect, revoke, or resolve', () => {
  const h = handles();
  const { lifecycle } = makeLifecycle(undefined, h);
  assert.throws(() => lifecycle.inspectHandle({ handleId: 'ch_adapter_test', tenant: 'tenant_b', adapterId: 'adp_0001' }), { code: 'adapter_credential_scope_mismatch' });
  assert.throws(() => lifecycle.revokeHandle({ handleId: 'ch_adapter_test', tenant: 'tenant_a', adapterId: 'adp_0002' }), { code: 'adapter_credential_scope_mismatch' });
  assert.throws(() => lifecycle.resolveForBroker({ handleId: 'ch_adapter_test', tenant: 'tenant_b', adapterId: 'adp_0001', request: {} }), { code: 'adapter_credential_scope_mismatch' });
  assert.equal(h.calls.length, 0);
});

test('delegates revoke and broker resolution only after binding checks', () => {
  const h = handles();
  const { lifecycle } = makeLifecycle(undefined, h);
  const revoked = lifecycle.revokeHandle({ handleId: 'ch_adapter_test', tenant: 'tenant_a', adapterId: 'adp_0001', reason: 'operator_rotation' });
  assert.equal(revoked.revokedReason, 'operator_rotation');
  const resolved = lifecycle.resolveForBroker({ handleId: 'ch_adapter_test', tenant: 'tenant_a', adapterId: 'adp_0001', request: { tenant: 'tenant_a' } });
  assert.equal(resolved.secret, 'runtime-only');
  assert.equal(h.calls.filter((call) => call[0] === 'revoke').length, 1);
  assert.equal(h.calls.filter((call) => call[0] === 'resolveForBroker').length, 1);
});
