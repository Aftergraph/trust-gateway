'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapterTestDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-governed-db-'));
const adapterTestDbFile = path.join(adapterTestDbDir, 'gateway.db');
const previousAdapterTestDbFile = process.env.TG_DB_FILE;
process.env.TG_DB_FILE = adapterTestDbFile;

const { Gateway } = require('../src/gateway/server');
const { getAdapters } = require('../src/gateway/adapters-singleton');
const { closeDb } = require('../src/gateway/db');

function bearer(token) { return 'Bea' + 'rer ' + token; }

test.after(() => {
  closeDb();
  if (previousAdapterTestDbFile === undefined) delete process.env.TG_DB_FILE;
  else process.env.TG_DB_FILE = previousAdapterTestDbFile;
  fs.rmSync(adapterTestDbDir, { recursive: true, force: true });
});

async function request(base, pathname, options = {}) {
  const headers = { authorization: bearer(options.token || 'tok-operator') };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + pathname, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, text: await response.text() };
}

test('adapter test route is fail-closed and never reaches legacy fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-governed-route-'));
  const gw = new Gateway({
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/70-adapters')],
    bots: { operator: { token: 'tok-operator', role: 'operator', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
    telemetryFile: null,
  });
  const registry = getAdapters(gw, { file: path.join(dir, 'adapters.json') });
  const adapter = registry.register({
    kind: 'webhook',
    name: 'route gate',
    config: { url: 'https://hooks.example.test/health' },
  });
  const calls = [];
  registry._fetch = async () => { calls.push(true); return { status: 200 }; };

  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await request(base, '/' + 'v2/adapters/' + adapter.id + '/test', { method: 'POST', body: {} });
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.text), { error: 'governed_egress_required' });
    assert.equal(calls.length, 0);
    const blocked = gw.chain.entries.find((entry) => entry.payload.type === 'adapter_test_blocked');
    assert.deepEqual(blocked.payload, {
      type: 'adapter_test_blocked',
      id: adapter.id,
      tenant: 'main',
      bot: 'operator',
      reason: 'governed_egress_required',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

 
test('wired adapter test route uses trusted resolver and adapter-bound broker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-governed-wired-'));
  const seen = [];
  const gw = new Gateway({
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/70-adapters')],
    bots: { operator: { token: 'tok-operator', role: 'operator', capabilities: ['*'] } },
    adapterContextResolver: async ({ credentialHandle }) => ({
      requestId: 'req_route_1', correlationId: 'corr_route_1', principalId: 'principal_1',
      missionId: 'mission_1', authorityRef: 'authority_1', credentialHandle,
    }),
    governedEgressBroker: {
      requireAdapterBinding: true,
      async admit(request) { seen.push({ phase: 'admit', request }); return { ok: true }; },
      async dispatch(admission, request) { seen.push({ phase: 'dispatch', admission, request }); return { status: 204 }; },
    },
    telemetryFile: null,
  });
  const registry = getAdapters(gw, { file: path.join(dir, 'adapters.json') });
  const adapter = registry.register({ kind: 'webhook', name: 'wired hook', config: { url: 'https://hooks.example.test/health' } });
  registry._fetch = async () => { throw new Error('legacy_fetch_must_not_run'); };
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const spoof = await request(base, '/' + 'v2/adapters/' + adapter.id + '/test', {
      method: 'POST', body: { credentialHandle: 'hnd_opaque_1', tenantId: 'attacker-tenant' },
    });
    assert.equal(spoof.status, 400);
    assert.equal(seen.length, 0);
    const accepted = await request(base, '/' + 'v2/adapters/' + adapter.id + '/test', {
      method: 'POST', body: { credentialHandle: 'hnd_opaque_1' },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.text), { adapterId: adapter.id, ok: true, status: 204 });
    const routed = seen.find((entry) => entry.phase === 'admit').request;
    assert.equal(routed.tenantId, 'main');
    assert.equal(routed.adapterId, adapter.id);
    assert.equal(routed.purpose, 'adapter_probe');
    assert.equal(routed.data.resourceRef, 'adapter:' + adapter.id);
    assert.ok(!JSON.stringify(gw.chain.entries).includes('attacker-tenant'));
    assert.ok(gw.chain.entries.some((entry) => entry.payload.type === 'adapter_test_governed'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wired adapter credential route requires operator and uses Vault lifecycle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-credential-wired-'));
  const writes = [];
  const secret = 'wire-secret-never-echoed';
  const gw = new Gateway({
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/70-adapters')],
    bots: {
      operator: { token: 'tok-operator', role: 'operator', capabilities: ['*'] },
      worker: { token: 'tok-worker', role: 'worker', capabilities: [] },
    },
    adapterCredentialLifecycle: {
      setSecret(input) {
        writes.push(input);
        return { ok: true, tenant: input.tenant, adapterId: input.adapterId, secretName: String(input.secretName).toLowerCase() };
      },
    },
    telemetryFile: null,
  });
  const registry = getAdapters(gw, { file: path.join(dir, 'adapters.json') });
  const adapter = registry.register({ kind: 'webhook', name: 'credential hook', config: { url: 'https://hooks.example.test/health' } });
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const denied = await request(base, '/' + 'v2/adapters/' + adapter.id + '/secret', { method: 'POST', token: 'tok-worker', body: { name: 'sig', value: secret } });
    assert.equal(denied.status, 403);
    assert.deepEqual(JSON.parse(denied.text), { error: 'operator_required' });
    assert.equal(writes.length, 0);
    const accepted = await request(base, '/' + 'v2/adapters/' + adapter.id + '/secret', { method: 'POST', body: { name: 'sig', value: secret } });
    assert.equal(accepted.status, 201);
    assert.deepEqual(JSON.parse(accepted.text), { credential: { adapterId: adapter.id, secretName: 'sig' } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].tenant, 'main');
    assert.equal(writes[0].adapterId, adapter.id);
    assert.equal(writes[0].value, secret);
    assert.ok(!accepted.text.includes(secret));
    assert.ok(!JSON.stringify(gw.chain.entries).includes(secret));
    assert.ok(gw.chain.entries.some((entry) => entry.payload.type === 'adapter_credentials_set'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('adapter management mutations require operator or adapter.manage capability', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-management-gate-'));
  const gw = new Gateway({
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/70-adapters')],
    bots: {
      operator: { token: 'tok-operator', role: 'operator', capabilities: ['*'] },
      manager: { token: 'tok-manager', role: 'worker', capabilities: ['adapter.manage'] },
      worker: { token: 'tok-worker', role: 'worker', capabilities: [] },
    },
    telemetryFile: null,
  });
  const registry = getAdapters(gw, { file: path.join(dir, 'adapters.json') });
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const deniedRegister = await request(base, '/v2/adapters', {
      method: 'POST',
      token: 'tok-worker',
      body: { kind: 'webhook', name: 'denied', config: { url: 'https://hooks.example.test/health' } },
    });
    assert.equal(deniedRegister.status, 403);
    assert.deepEqual(JSON.parse(deniedRegister.text), { error: 'operator_required' });
    assert.equal(registry.list().length, 0);

    const acceptedRegister = await request(base, '/v2/adapters', {
      method: 'POST',
      token: 'tok-manager',
      body: { kind: 'webhook', name: 'managed', config: { url: 'https://hooks.example.test/health' } },
    });
    assert.equal(acceptedRegister.status, 201);
    const adapter = JSON.parse(acceptedRegister.text).adapter;
    assert.equal(adapter.name, 'managed');

    const deniedPatch = await request(base, '/v2/adapters/' + adapter.id, {
      method: 'PATCH',
      token: 'tok-worker',
      body: { name: 'worker-tampered' },
    });
    assert.equal(deniedPatch.status, 403);
    assert.deepEqual(JSON.parse(deniedPatch.text), { error: 'operator_required' });
    assert.equal(registry.get(adapter.id).name, 'managed');

    const deniedDelete = await request(base, '/v2/adapters/' + adapter.id, {
      method: 'DELETE',
      token: 'tok-worker',
    });
    assert.equal(deniedDelete.status, 403);
    assert.deepEqual(JSON.parse(deniedDelete.text), { error: 'operator_required' });
    assert.ok(registry.get(adapter.id));

    const denied = gw.chain.entries.filter((entry) => entry.payload.type === 'adapter_management_forbidden');
    assert.equal(denied.length, 3);
    assert.ok(denied.every((entry) => entry.payload.reason === 'operator_required'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('adapter handle control plane is operator-gated, tenant-bound, and secret-free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-handle-control-'));
  const calls = [];
  const secret = 'handle-secret-never-echoed';
  const gw = new Gateway({
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/70-adapters')],
    bots: {
      operator: { token: 'tok-operator', role: 'operator', capabilities: ['*'] },
      worker: { token: 'tok-worker', role: 'worker', capabilities: [] },
    },
    adapterCredentialLifecycle: {
      issueHandle(input) {
        calls.push(['issue', input]);
        return {
          handleId: 'ch_opaque_demo',
          tenant: input.tenant,
          adapterId: input.adapterId,
          purpose: input.purpose,
          secretName: input.secretName,
          secret,
        };
      },
      inspectHandle(input) {
        calls.push(['inspect', input]);
        return { handleId: input.handleId, tenant: input.tenant, adapterId: input.adapterId, secret };
      },
      revokeHandle(input) {
        calls.push(['revoke', input]);
        return { handleId: input.handleId, tenant: input.tenant, adapterId: input.adapterId, revokedAt: 1234, secret };
      },
    },
    telemetryFile: null,
  });
  const registry = getAdapters(gw, { file: path.join(dir, 'adapters.json') });
  const adapter = registry.register({ kind: 'webhook', name: 'handle hook', config: { url: 'https://hooks.example.test/health' } });
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const issueBody = {
    secretName: 'token',
    principalId: 'principal_1',
    missionId: 'mission_1',
    authorityRef: 'authority_1',
    credentialClass: 'api_token',
    allowedDestinations: ['hooks.example.test'],
    allowedMethods: ['POST'],
    allowedPathPrefixes: ['/health'],
    scopeRefs: ['mission:mission_1'],
    expiresAt: Date.now() + 60000,
  };
  try {
    const unknown = await request(base, '/v2/adapters/adp_9999/handle', {
      method: 'POST',
      body: issueBody,
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { error: 'not_found' });
    assert.equal(calls.length, 0);

    const denied = await request(base, '/v2/adapters/' + adapter.id + '/handle', {
      method: 'POST',
      token: 'tok-worker',
      body: issueBody,
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(JSON.parse(denied.text), { error: 'operator_required' });
    assert.equal(calls.length, 0);

    const spoof = await request(base, '/v2/adapters/' + adapter.id + '/handle', {
      method: 'POST',
      body: { ...issueBody, tenant: 'attacker-tenant' },
    });
    assert.equal(spoof.status, 400);
    assert.equal(calls.length, 0);

    const issued = await request(base, '/v2/adapters/' + adapter.id + '/handle', {
      method: 'POST',
      body: issueBody,
    });
    assert.equal(issued.status, 201);
    const issuedJson = JSON.parse(issued.text);
    assert.equal(issuedJson.handle.handleId, 'ch_opaque_demo');
    assert.equal(issuedJson.handle.secret, undefined);
    assert.ok(!issued.text.includes(secret));
    assert.deepEqual(calls[0][1], { ...issueBody, tenant: 'main', adapterId: adapter.id, purpose: 'adapter_probe' });

    const inspected = await request(base, '/v2/adapters/' + adapter.id + '/handle/ch_opaque_demo');
    assert.equal(inspected.status, 200);
    assert.equal(JSON.parse(inspected.text).handle.secret, undefined);
    assert.ok(!inspected.text.includes(secret));

    const revoked = await request(base, '/v2/adapters/' + adapter.id + '/handle/ch_opaque_demo/revoke', {
      method: 'POST',
      body: { reason: 'operator_rotation' },
    });
    assert.equal(revoked.status, 200);
    assert.equal(JSON.parse(revoked.text).handle.secret, undefined);
    assert.ok(!revoked.text.includes(secret));
    assert.deepEqual(calls[calls.length - 1][1], {
      handleId: 'ch_opaque_demo',
      tenant: 'main',
      adapterId: adapter.id,
      reason: 'operator_rotation',
    });
    assert.ok(!JSON.stringify(gw.chain.entries).includes(secret));
    assert.ok(gw.chain.entries.some((entry) => entry.payload.type === 'adapter_handle_issued'));
    assert.ok(gw.chain.entries.some((entry) => entry.payload.type === 'adapter_handle_inspected'));
    assert.ok(gw.chain.entries.some((entry) => entry.payload.type === 'adapter_handle_revoked'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
