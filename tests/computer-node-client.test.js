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
const { config } = require('../src/gateway/computer-node-client');

const TOKEN = 'n'.repeat(48);

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-node-client-'));
  return path.join(dir, name);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

function makeGateway() {
  return new Gateway({
    bots: {
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

async function call(base, method, p, body = null) {
  const res = await fetch(base + p, {
    method,
    headers: {
      authorization: 'Bearer tok-atlas',
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function clearNodeEnv() {
  delete process.env.TG_COMPUTER_NODE_URL;
  delete process.env.TG_COMPUTER_NODE_TOKEN;
}

test('computer node config: plaintext HTTP is loopback-only', () => {
  process.env.TG_COMPUTER_NODE_TOKEN = TOKEN;

  process.env.TG_COMPUTER_NODE_URL = 'http://127.0.0.1:7799';
  assert.equal(config().ok, true);

  process.env.TG_COMPUTER_NODE_URL = 'http://localhost:7799';
  assert.equal(config().ok, true);

  process.env.TG_COMPUTER_NODE_URL = 'http://10.0.0.42:7799';
  assert.deepEqual(
    { ok: config().ok, error: config().error },
    { ok: false, error: 'tls_required' },
  );

  process.env.TG_COMPUTER_NODE_URL = 'https://computer.example.test';
  assert.equal(config().ok, true);
  clearNodeEnv();
});

test('computer node client: coalesces multi-provider inspection, preserves provenance, and audits outcome', async () => {
  const seen = [];
  let inspectCalls = 0;
  const node = http.createServer(async (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/manifest') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [
          {
            id: 'native-windows',
            kind: 'native',
            version: '0.1.0',
            nodeId: 'jonas-lenovo',
            capabilities: ['computer.health.inspect'],
          },
          {
            id: 'cua-local',
            kind: 'cua-driver',
            version: '1.0.0',
            nodeId: 'jonas-lenovo',
            capabilities: ['computer.health.inspect'],
          },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/inspect') {
      inspectCalls += 1;
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: ['native-windows', 'cua-local'],
        findings: [
          {
            type: 'orphan_process',
            severity: 'warning',
            summary: 'node PID 100 has missing parent PID 999',
            evidenceRefs: ['windows:process:100'],
            recommendedCapability: 'computer.process.stop',
            providerId: 'native-windows',
          },
          {
            type: 'stuck_dialog',
            severity: 'info',
            summary: 'one modal dialog is visible',
            evidenceRefs: ['cua:window:1'],
            recommendedCapability: null,
            providerId: 'cua-local',
          },
        ],
        errors: [],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const nodeBase = await listen(node);
  process.env.TG_COMPUTER_NODE_URL = nodeBase;
  process.env.TG_COMPUTER_NODE_TOKEN = TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer.json');

  const gateway = makeGateway();
  const gatewayServer = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(gatewayServer);

  try {
    const providers = await call(base, 'GET', '/v2/computer/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.body.providers.length, 2);
    assert.equal(providers.body.providers[0].url, undefined);
    assert.equal(providers.body.providers[0].token, undefined);

    const health = await call(base, 'POST', '/v2/computer/inspect', {
      scope: 'health',
      depth: 'forensic',
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.findings.length, 2);
    assert.deepEqual(
      health.body.findings.map((row) => row.providerId).sort(),
      ['cua-local', 'native-windows'],
    );
    assert.equal(inspectCalls, 1);

    const audits = gateway.chain.entries.map((entry) => entry.payload)
      .filter((payload) => payload && payload.type === 'computer_inspection');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].bot, 'atlas');
    assert.equal(audits[0].depth, 'forensic');
    assert.equal(audits[0].outcome, 'success');
    assert.equal(audits[0].providerCount, 2);
    assert.equal(audits[0].findingCount, 2);
    assert.equal(audits[0].errorCount, 0);
    assert.equal(audits[0].findings, undefined);

    assert.ok(seen.every((row) => row.auth === `Bearer ${TOKEN}`));
    assert.ok(!JSON.stringify(providers.body).includes(TOKEN));
    assert.ok(!JSON.stringify(health.body).includes(TOKEN));
  } finally {
    clearNodeEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
  }
});

test('computer node client: omitted provider success fails closed', async () => {
  const node = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/manifest') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [{
          id: 'native-windows',
          kind: 'native',
          version: '0.1.0',
          nodeId: 'jonas-lenovo',
          capabilities: ['computer.health.inspect'],
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/inspect') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [],
        findings: [],
        errors: [],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  process.env.TG_COMPUTER_NODE_URL = await listen(node);
  process.env.TG_COMPUTER_NODE_TOKEN = TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer-omitted-success.json');

  const gateway = makeGateway();
  const gatewayServer = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(gatewayServer);
  try {
    const health = await call(base, 'POST', '/v2/computer/inspect', {
      scope: 'health',
      depth: 'standard',
    });
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.unavailable, true);
    assert.deepEqual(health.body.providers, []);
    assert.deepEqual(health.body.errors, [
      { providerId: 'native-windows', error: 'provider_failed' },
    ]);
  } finally {
    clearNodeEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
  }
});

test('computer node client: provider errors are not converted into clean findings', async () => {
  const node = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/manifest') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [{
          id: 'native-windows',
          kind: 'native',
          version: '0.1.0',
          nodeId: 'jonas-lenovo',
          capabilities: ['computer.health.inspect'],
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/inspect') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [],
        findings: [],
        errors: [{ providerId: 'native-windows', error: 'provider_failed' }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  process.env.TG_COMPUTER_NODE_URL = await listen(node);
  process.env.TG_COMPUTER_NODE_TOKEN = TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer-errors.json');

  const gateway = makeGateway();
  const gatewayServer = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(gatewayServer);
  try {
    const health = await call(base, 'POST', '/v2/computer/inspect', {
      scope: 'health',
      depth: 'standard',
    });
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.unavailable, true);
    assert.equal(health.body.partial, false);
    assert.deepEqual(health.body.findings, []);
    assert.deepEqual(health.body.errors, [
      { providerId: 'native-windows', error: 'provider_failed' },
    ]);

    const audits = gateway.chain.entries.map((entry) => entry.payload)
      .filter((payload) => payload && payload.type === 'computer_inspection');
    assert.equal(audits.at(-1).outcome, 'unavailable');
    assert.equal(audits.at(-1).providerCount, 0);
    assert.equal(audits.at(-1).errorCount, 1);
  } finally {
    clearNodeEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
  }
});

test('computer node client: refuses HTTP redirects instead of following node transport', async () => {
  const redirectTarget = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ nodeId: 'should-not-be-reached', providers: [] }));
  });
  const targetBase = await listen(redirectTarget);

  const redirector = http.createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', targetBase + '/v1/manifest');
    res.end();
  });
  const redirectBase = await listen(redirector);

  process.env.TG_COMPUTER_NODE_URL = redirectBase;
  process.env.TG_COMPUTER_NODE_TOKEN = TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer-redirect.json');

  const gateway = makeGateway();
  const gatewayServer = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(gatewayServer);
  try {
    const result = await call(base, 'GET', '/v2/computer/providers');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'computer_node_unavailable');
    assert.equal(result.body.reason, 'node_unavailable');
  } finally {
    clearNodeEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => redirectTarget.close(resolve));
  }
});

test('computer node client: incomplete config fails closed without leaking configuration', async () => {
  process.env.TG_COMPUTER_NODE_URL = 'http://127.0.0.1:1';
  delete process.env.TG_COMPUTER_NODE_TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer.json');

  const gateway = makeGateway();
  const gatewayServer = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(gatewayServer);
  try {
    const result = await call(base, 'GET', '/v2/computer/providers');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'computer_node_unavailable');
    assert.equal(result.body.reason, 'incomplete_configuration');
    assert.ok(!JSON.stringify(result.body).includes('127.0.0.1:1'));
  } finally {
    clearNodeEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
  }
});
