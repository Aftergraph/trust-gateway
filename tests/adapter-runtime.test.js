'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdapterRuntime } = require('../src/gateway/adapter-runtime');
const { Gateway } = require('../src/gateway/server');

function dependencies(overrides = {}) {
  return {
    vault: { setSecret() {}, listKeys() { return []; }, getSecret() { return null; } },
    handles: { validate() {}, resolveForBroker() {} },
    tenantStore: { get() { return { id: 'main', disabled: false }; } },
    adapterContextResolver() {},
    authorityCheck: async () => ({ ok: true, version: 'v1' }),
    approvalCheck: async () => ({ ok: true, expiresAt: 9999 }),
    destinationPolicy: [{ host: 'api.example.test', schemes: ['https'], ports: [443], methods: ['GET'], pathPrefixes: ['/'] }],
    credentialInjector: () => ({}),
    transport: async () => ({ status: 204, connectedAddress: '203.0.113.8' }),
    commitGuard: async () => ({ ok: true, permitId: 'permit-1' }),
    audit() {},
    ...overrides,
  };
}

test('composes an adapter runtime with scoped handles and mandatory broker binding', () => {
  const runtime = createAdapterRuntime(dependencies());
  assert.equal(typeof runtime.adapterContextResolver, 'function');
  assert.equal(typeof runtime.adapterCredentialLifecycle.setSecret, 'function');
  assert.equal(runtime.governedEgressBroker.requireAdapterBinding, true);
  assert.notEqual(runtime.governedEgressBroker.handleStore, dependencies().handles);
});

test('runtime factory fails closed when policy or governance dependencies are absent', () => {
  assert.throws(() => createAdapterRuntime(dependencies({ destinationPolicy: [] })), { code: 'adapter_runtime_destination_policy_required' });
  assert.throws(() => createAdapterRuntime(dependencies({ authorityCheck: null })), { code: 'adapter_runtime_authority_check_required' });
  assert.throws(() => createAdapterRuntime(dependencies({ approvalCheck: null })), { code: 'adapter_runtime_approval_check_required' });
  assert.throws(() => createAdapterRuntime(dependencies({ commitGuard: null })), { code: 'adapter_runtime_commit_guard_required' });
  assert.throws(() => createAdapterRuntime(dependencies({ adapterContextResolver: null })), { code: 'adapter_runtime_context_resolver_required' });
});


test('Gateway accepts the composed adapter runtime as one explicit injection seam', () => {
  const runtime = createAdapterRuntime(dependencies());
  const gw = new Gateway({ mountFiles: false, telemetryFile: null, adapterRuntime: runtime });
  assert.equal(gw.governedEgressBroker, runtime.governedEgressBroker);
  assert.equal(gw.adapterCredentialLifecycle, runtime.adapterCredentialLifecycle);
  assert.equal(gw.adapterContextResolver, runtime.adapterContextResolver);
});
