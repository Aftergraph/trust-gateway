'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-request-'));
process.env.TG_DB_FILE = path.join(root, 'gateway.db');
process.env.TG_DATA_DIR = path.join(root, 'data');
process.env.TG_ROOMS_FILE = path.join(root, 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const { getTenantStore } = require('../src/gateway/tenants');
const { getRoomStore } = require('../src/gateway/groups');

function request(port, token, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

test('shared gateway binds chain reads and writes to the authenticated tenant', async () => {
  const gateway = new Gateway({
    bots: {
      a: { token: 'tnt_tenant-a_token-a', role: 'worker', capabilities: ['*'] },
      b: { token: 'tnt_tenant-b_token-b', role: 'worker', capabilities: ['*'] },
    },
  });
  const server = http.createServer((req, res) => gateway.handle(req, res));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const tenants = getTenantStore(gateway);
    tenants.create({ name: 'tenant-a' });
    tenants.create({ name: 'tenant-b' });
    const room = getRoomStore(gateway).create({ name: 'shared-id', bots: ['a', 'b'] });

    const aPost = await request(port, 'tnt_tenant-a_token-a', 'POST', `/v2/rooms/${room.id}/messages`, { from: 'a', body: 'A-only' });
    const bPost = await request(port, 'tnt_tenant-b_token-b', 'POST', `/v2/rooms/${room.id}/messages`, { from: 'b', body: 'B-only' });
    assert.equal(aPost.status, 201);
    assert.equal(bPost.status, 201);

    const aChain = await request(port, 'tnt_tenant-a_token-a', 'GET', `/v2/rooms/${room.id}/chain`);
    const bChain = await request(port, 'tnt_tenant-b_token-b', 'GET', `/v2/rooms/${room.id}/chain`);
    assert.equal(aChain.status, 200, JSON.stringify(aChain));
    assert.equal(bChain.status, 200, JSON.stringify(bChain));
    assert.equal(aChain.body.tree.from, 'a');
    assert.equal(bChain.body.tree.from, 'b');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unknown tenant chain access fails closed without exposing graph data', async () => {
  const gateway = new Gateway({
    bots: { a: { token: 'tnt_tenant-a_token-a', role: 'worker', capabilities: ['*'] } },
  });
  const server = http.createServer((req, res) => gateway.handle(req, res));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const room = getRoomStore(gateway).create({ name: 'unknown-tenant', bots: ['a'] });
    const response = await request(port, 'tnt_missing_token', 'GET', `/v2/rooms/${room.id}/chain`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
