'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductionAdapterRuntime, isEnabled } = require('../src/gateway/production-adapter-runtime');

function storage() {
  return {
    vault: { setSecret() {}, listKeys() { return []; }, getSecret() { return null; } },
    handles: { validate() {}, resolveForBroker() {} },
    tenantStore: { get() { return { id: 'main', disabled: false }; } },
  };
}

function governance(overrides = {}) {
  return {
    createAdapterGovernance() {
      return {
        adapterContextResolver() {},
        authorityCheck: async () => ({ ok: true }),
        approvalCheck: async () => ({ ok: true, expiresAt: Date.now() + 60_000 }),
        credentialInjector: ({ request }) => request,
        commitGuard: async () => ({ ok: true, permitId: 'permit-production-test' }),
        destinationPolicy: [{
          host: 'api.example.test',
          schemes: ['https'],
          ports: [443],
          methods: ['GET'],
          pathPrefixes: ['/'],
        }],
        ...overrides,
      };
    },
  };
}

test('production runtime is inert unless explicitly enabled', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(createProductionAdapterRuntime({ env: {}, audit() {} }), null);
});

test('enabled runtime requires an explicit governance module', () => {
  assert.throws(
    () => createProductionAdapterRuntime({ env: { TG_ADAPTER_RUNTIME: '1' }, audit() {}, storage: storage() }),
    { code: 'adapter_runtime_governance_module_required' },
  );
});

test('enabled runtime requires every policy boundary and a non-empty destination policy', () => {
  assert.throws(
    () => createProductionAdapterRuntime({
      env: { TG_ADAPTER_RUNTIME: '1' },
      audit() {},
      governanceModule: governance({ authorityCheck: undefined }),
      storage: storage(),
    }),
    { code: 'adapter_runtime_authority_check_required' },
  );
  assert.throws(
    () => createProductionAdapterRuntime({
      env: { TG_ADAPTER_RUNTIME: '1' },
      audit() {},
      governanceModule: governance({ destinationPolicy: [] }),
      storage: storage(),
    }),
    { code: 'adapter_runtime_destination_policy_required' },
  );
});

test('enabled runtime composes the governed broker with pinned transport options', () => {
  const runtime = createProductionAdapterRuntime({
    env: { TG_ADAPTER_RUNTIME: '1' },
    audit() {},
    governanceModule: governance(),
    storage: storage(),
    transportOptions: { maxRequestBytes: 4096, maxResponseBytes: 8192, timeoutMs: 1000 },
  });
  assert.equal(runtime.governedEgressBroker.requireAdapterBinding, true);
  assert.equal(typeof runtime.adapterCredentialLifecycle.issueHandle, 'function');
  assert.equal(typeof runtime.adapterContextResolver, 'function');
});

test('production runtime rejects custom transports', () => {
  assert.throws(
    () => createProductionAdapterRuntime({
      env: { TG_ADAPTER_RUNTIME: '1' },
      audit() {},
      governanceModule: governance({ transport: async () => ({}) }),
      storage: storage(),
    }),
    { code: 'adapter_runtime_custom_transport_forbidden' },
  );
});
