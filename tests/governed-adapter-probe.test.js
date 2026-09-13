'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  buildWebhookProbeRequest,
  buildHttpApiProbeRequest,
  runGovernedAdapterProbe,
} = require('../src/gateway/governed-adapter-probe');
const { createGovernedEgressBroker } = require('../src/gateway/governed-egress');

function context(overrides = {}) {
  return {
    requestId: 'req_adapter_probe_1',
    correlationId: 'corr_adapter_probe_1',
    principalId: 'principal_1',
    missionId: 'mission_1',
    authorityRef: 'authority_1',
    purpose: 'adapter_probe',
    credentialHandle: 'ch_test_1',
    now: 1788380000000,
    ...overrides,
  };
}

function webhook() {
  return { id: 'adp_0001', kind: 'webhook', config: { url: 'https://hooks.example.test/health' } };
}

function httpApi(auth = 'header') {
  return { id: 'adp_0002', kind: 'http-api', config: { baseUrl: 'https://api.example.test/v1/health', auth } };
}

function fakeHttpModule(remoteAddress) {
  const state = { calls: 0, options: null, body: null };
  const module = {
    request(options, callback) {
      state.calls += 1;
      state.options = options;
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = (body) => {
        state.body = body ? body.toString() : null;
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 204;
          response.headers = {};
          response.socket = { remoteAddress };
          response.destroy = () => {};
          callback(response);
          response.emit('end');
        });
      };
      return request;
    },
  };
  return { module, state };
}

test('builds a secret-free webhook descriptor with a body digest', () => {
  const request = buildWebhookProbeRequest(webhook(), context());
  assert.deepEqual(request.destination, {
    scheme: 'https', host: 'hooks.example.test', port: 443, path: '/health', query: {},
  });
  assert.equal(request.http.method, 'POST');
  assert.match(request.http.bodyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(request.http.headers.authorization, undefined);
  assert.equal(JSON.stringify(request).includes('secret'), false);
});

test('builds only header-auth HTTP API descriptors and rejects query auth', () => {
  const request = buildHttpApiProbeRequest(httpApi(), context());
  assert.equal(request.destination.host, 'api.example.test');
  assert.equal(request.http.method, 'GET');
  assert.deepEqual(request.http.query, {});
  assert.throws(() => buildHttpApiProbeRequest(httpApi('query'), context()), {
    code: 'adapter_query_auth_unsupported',
  });
  assert.throws(() => buildHttpApiProbeRequest({
    ...httpApi(), config: { baseUrl: 'https://api.example.test/v1?token=secret', auth: 'header' },
  }, context()), { code: 'adapter_query_auth_unsupported' });
});

test('requires complete governed context and rejects URL credentials', () => {
  assert.throws(() => buildWebhookProbeRequest(webhook(), { ...context(), missionId: '' }), {
    code: 'governed_adapter_context_required',
  });
  assert.throws(() => buildWebhookProbeRequest({
    ...webhook(), config: { url: 'https://user:pass@hooks.example.test/health' },
  }, context()), { code: 'adapter_target_invalid' });
});

test('probe runner delegates only admit then dispatch', async () => {
  const calls = [];
  const broker = {
    admit: async (request) => { calls.push(['admit', request]); return { admissionId: 'a1' }; },
    dispatch: async (admission, request) => { calls.push(['dispatch', admission, request]); return { status: 204 }; },
  };
  const result = await runGovernedAdapterProbe({
    broker, request: buildWebhookProbeRequest(webhook(), context()),
  });
  assert.equal(result.status, 204);
  assert.deepEqual(calls.map((entry) => entry[0]), ['admit', 'dispatch']);
});

test('factory composes pinned transport for a broker-to-transport probe', async () => {
  const fake = fakeHttpModule('8.8.8.8');
  const audits = [];
  const broker = createGovernedEgressBroker({
    handleStore: {
      validate() {},
      resolveForBroker() { return { tenant: 'tenant_a', secretKey: 'probe', secret: '' }; },
    },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    authorityCheck: async () => ({ ok: true, version: 'a1' }),
    approvalCheck: async () => ({ ok: true, expiresAt: Date.now() + 60_000 }),
    destinationPolicy: [{
      host: 'hooks.example.test', schemes: ['https'], ports: [443], methods: ['POST'], pathPrefixes: ['/health'],
    }],
    audit: (event) => audits.push(event),
    credentialInjector: ({ request }) => request,
    commitGuard: async () => ({ ok: true, permitId: 'permit_probe_1' }),
    transportOptions: { httpsModule: fake.module, httpModule: fake.module },
  });
  const result = await runGovernedAdapterProbe({
    broker, request: buildWebhookProbeRequest(webhook(), context()),
  });
  assert.equal(result.status, 204);
  assert.equal(result.connectedAddress, '8.8.8.8');
  assert.equal(fake.state.calls, 1);
  assert.equal(fake.state.options.hostname, 'hooks.example.test');
  assert.equal(fake.state.options.servername, 'hooks.example.test');
  assert.equal(audits.some((event) => event.type === 'egress_admitted'), true);
  assert.equal(audits.some((event) => event.type === 'egress_dispatched'), true);
});

test('rejects credential injectors that mutate the admitted execution envelope', async () => {
  let transportCalls = 0;
  const broker = createGovernedEgressBroker({
    handleStore: {
      validate() {},
      resolveForBroker() { return { tenant: 'tenant_a', secretKey: 'probe', secret: 'runtime-secret' }; },
    },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    authorityCheck: async () => ({ ok: true }),
    approvalCheck: async () => ({ ok: true }),
    destinationPolicy: [{
      host: 'hooks.example.test', schemes: ['https'], ports: [443], methods: ['POST'], pathPrefixes: ['/health'],
    }],
    credentialInjector: ({ request }) => ({
      ...request,
      destination: { ...request.destination, host: 'evil.example.test' },
    }),
    commitGuard: async () => ({ ok: true, permitId: 'permit_mutation_1' }),
    transport: async () => { transportCalls += 1; return { status: 204, connectedAddress: '8.8.8.8' }; },
  });
  const request = buildWebhookProbeRequest(webhook(), context());
  const admission = await broker.admit(request);
  await assert.rejects(
    () => broker.dispatch(admission, request),
    { code: 'request_mutated_during_credential_injection' },
  );
  assert.equal(transportCalls, 0);
});
