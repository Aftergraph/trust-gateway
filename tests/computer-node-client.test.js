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

test('computer node client: attaches remote provider and preserves provider provenance', async () => {
  const seen = [];
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
        providers: [{
          id: 'native-windows',
          kind: 'native',
          version: '0.1.0',
          nodeId: 'jonas-lenovo',
          capabilities: ['computer.health.inspect', 'computer.process.list'],
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/inspect') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: ['native-windows'],
        findings: [{
          type: 'orphan_process',
          severity: 'warning',
          summary: 'node PID 100 has missing parent PID 999',
          evidenceRefs: ['windows:process:100'],
          recommendedCapability: 'computer.process.stop',
          providerId: 'native-windows',
        }],
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
    assert.equal(providers.body.providers.length, 1);
    assert.equal(providers.body.providers[0].id, 'native-windows');
    assert.equal(providers.body.providers[0].nodeId, 'jonas-lenovo');
    assert.equal(providers.body.providers[0].url, undefined);
    assert.equal(providers.body.providers[0].token, undefined);

    const health = await call(base, 'POST', '/v2/computer/inspect', {
      scope: 'health',
      depth: 'forensic',
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.findings.length, 1);
    assert.equal(health.body.findings[0].providerId, 'native-windows');
    assert.equal(health.body.findings[0].nodeId, 'jonas-lenovo');
    assert.equal(health.body.findings[0].type, 'orphan_process');

    assert.ok(seen.every((row) => row.auth === `Bearer ${TOKEN}`));
    assert.ok(!JSON.stringify(providers.body).includes(TOKEN));
    assert.ok(!JSON.stringify(health.body).includes(TOKEN));
  } finally {
    delete process.env.TG_COMPUTER_NODE_URL;
    delete process.env.TG_COMPUTER_NODE_TOKEN;
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
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
    delete process.env.TG_COMPUTER_NODE_URL;
    await new Promise((resolve) => gatewayServer.close(resolve));
  }
});
