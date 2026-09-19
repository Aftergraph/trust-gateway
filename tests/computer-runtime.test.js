'use strict';
process.env.TG_DB_FILE = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')),
  'gateway.db',
);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const {
  CAPABILITIES,
  ComputerProviderRegistry,
  getComputerProviderRegistry,
} = require('../src/gateway/computer-runtime');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-v1-'));
  return path.join(dir, name);
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: [] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
    server.on('error', reject);
  });
}

async function call(base, method, p, { token = 'tok-atlas', body = null } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

test('computer v1: manifest is canonical, allowlisted, and projection excludes adapter internals', () => {
  const registry = new ComputerProviderRegistry();
  const adapter = {
    secret: 'must-never-project',
    endpoint: 'http://127.0.0.1:9999',
    inspectHealth: async () => ({ findings: [] }),
  };
  const out = registry.register({
    id: 'dc-local',
    kind: 'desktop-commander',
    version: '0.2.51',
    nodeId: 'jonas-lenovo',
    capabilities: [
      'computer.shell.start',
      'computer.health.inspect',
      'computer.process.list',
      'computer.health.inspect',
    ],
  }, adapter);

  assert.equal(out.ok, true);
  assert.deepEqual(out.provider.capabilities, [
    'computer.health.inspect',
    'computer.process.list',
    'computer.shell.start',
  ]);
  assert.equal(out.provider.secret, undefined);
  assert.equal(out.provider.endpoint, undefined);
  assert.equal(out.provider.adapter, undefined);
  assert.equal(registry.list()[0].secret, undefined);
});

test('computer v1: rejects unknown provider kinds and non-canonical capabilities', () => {
  const registry = new ComputerProviderRegistry();
  assert.equal(registry.register({
    id: 'bad',
    kind: 'mystery-shell',
    version: '1',
    capabilities: ['computer.health.inspect'],
  }, {}).error, 'bad_provider_kind');

  assert.equal(registry.register({
    id: 'bad2',
    kind: 'custom',
    version: '1',
    capabilities: ['shell.exec.anything'],
  }, {}).error, 'unknown_capability');

  assert.ok(CAPABILITIES.includes('computer.input.click'));
  assert.ok(CAPABILITIES.includes('computer.files.read'));
});

test('computer v1: health inspection sanitizes findings and reports partial provider failure', async () => {
  const registry = new ComputerProviderRegistry();
  registry.register({
    id: 'dc',
    kind: 'desktop-commander',
    version: '1',
    nodeId: 'jonas-lenovo',
    capabilities: ['computer.health.inspect', 'computer.process.list'],
  }, {
    inspectHealth: async ({ depth }) => ({
      findings: [
        {
          type: 'orphan_process',
          severity: 'warning',
          summary: `orphan node process detected at ${depth} depth`,
          evidenceRefs: ['process:18424', 'eventlog:abc'],
          recommendedCapability: 'computer.process.stop',
          rawOutput: 'THIS MUST NOT LEAK',
          commandLine: 'node secret.js --token=secret',
        },
        {
          type: 'bad finding with spaces',
          severity: 'critical',
          summary: 'invalid type must be discarded',
        },
      ],
    }),
  });

  registry.register({
    id: 'cua',
    kind: 'cua-driver',
    version: '1',
    nodeId: 'jonas-lenovo',
    capabilities: ['computer.health.inspect', 'computer.screen.capture'],
  }, {
    inspectHealth: async () => { throw new Error('driver unavailable'); },
  });

  const out = await registry.inspectHealth({ depth: 'forensic' });
  assert.equal(out.ok, false);
  assert.equal(out.partial, true);
  assert.equal(out.unavailable, false);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].type, 'orphan_process');
  assert.equal(out.findings[0].providerId, 'dc');
  assert.equal(out.findings[0].nodeId, 'jonas-lenovo');
  assert.equal(out.findings[0].rawOutput, undefined);
  assert.equal(out.findings[0].commandLine, undefined);
  assert.deepEqual(out.errors, [{ providerId: 'cua', error: 'provider_failed' }]);
});

test('computer v1: times out stuck providers and marks malformed provider output as failure', async () => {
  const registry = new ComputerProviderRegistry({ inspectionTimeoutMs: 20 });
  registry.register({
    id: 'stuck',
    kind: 'custom',
    version: '1',
    nodeId: 'jonas-lenovo',
    capabilities: ['computer.health.inspect'],
  }, {
    inspectHealth: async () => new Promise(() => {}),
  });
  registry.register({
    id: 'malformed',
    kind: 'custom',
    version: '1',
    nodeId: 'jonas-lenovo',
    capabilities: ['computer.health.inspect'],
  }, {
    inspectHealth: async () => ({ findings: 'not-an-array' }),
  });

  const out = await registry.inspectHealth({ depth: 'standard' });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(out.partial, false);
  assert.deepEqual(out.providers, []);
  assert.deepEqual(out.errors, [
    { providerId: 'stuck', error: 'provider_timeout' },
    { providerId: 'malformed', error: 'provider_malformed_result' },
  ]);
});

test('computer v1: no registered health provider fails closed as unavailable with no synthetic findings', async () => {
  const registry = new ComputerProviderRegistry();
  const out = await registry.inspectHealth({ depth: 'standard' });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.errors, []);
});

test('HTTP computer v1: providers and health inspect are operator-only', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer.json');
  const gw = makeGateway();
  const registry = getComputerProviderRegistry(gw);
  registry.register({
    id: 'dc-local',
    kind: 'desktop-commander',
    version: '0.2.51',
    nodeId: 'jonas-lenovo',
    capabilities: ['computer.health.inspect', 'computer.process.list'],
  }, {
    inspectHealth: async () => ({
      findings: [{
        type: 'resource_pressure',
        severity: 'info',
        summary: 'resource snapshot healthy',
        evidenceRefs: ['snapshot:1'],
        recommendedCapability: null,
      }],
    }),
  });

  const { server, base } = await listen(gw);
  try {
    const denied = await call(base, 'GET', '/v2/computer/providers', { token: 'tok-forge' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'operator_required');

    const queryToken = await fetch(base + '/v2/computer/providers?token=tok-atlas');
    assert.equal(queryToken.status, 401);

    const providers = await call(base, 'GET', '/v2/computer/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.body.providers.length, 1);
    assert.equal(providers.body.providers[0].id, 'dc-local');

    const inspect = await call(base, 'POST', '/v2/computer/inspect', {
      body: { scope: 'health', depth: 'forensic' },
    });
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.depth, 'forensic');
    assert.equal(inspect.body.findings[0].type, 'resource_pressure');

    const badDepth = await call(base, 'POST', '/v2/computer/inspect', {
      body: { scope: 'health', depth: 'infinite' },
    });
    assert.equal(badDepth.status, 400);
    assert.equal(badDepth.body.error, 'bad_depth');

    const deniedEvents = gw.chain.entries
      .map((e) => e.payload)
      .filter((p) => p && p.type === 'computer_control_denied');
    assert.ok(deniedEvents.some((p) => p.action === 'providers' && p.reason === 'operator_required'));
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP computer v1: inspect returns 503 until a real provider is attached', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-empty.json');
  const gw = makeGateway();
  const { server, base } = await listen(gw);
  try {
    const inspect = await call(base, 'POST', '/v2/computer/inspect', {
      body: { scope: 'health' },
    });
    assert.equal(inspect.status, 503);
    assert.equal(inspect.body.unavailable, true);
    assert.deepEqual(inspect.body.findings, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
