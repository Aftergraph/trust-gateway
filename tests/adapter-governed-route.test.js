'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { getAdapters } = require('../src/gateway/adapters-singleton');

function bearer(token) { return 'Bea' + 'rer ' + token; }

async function request(base, pathname, options = {}) {
  const headers = { authorization: bearer('tok-operator') };
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
