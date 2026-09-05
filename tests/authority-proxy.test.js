'use strict';
// Authority proxy tests — operator-only, fail-closed, no synthetic data.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-proxy-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const authorityProxy = require('../src/gateway/mounts/132-authority-proxy');

function makeGateway(opts = {}) {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    fnMounts: [authorityProxy],
    ...opts,
  });
}

function fetchJson(port, token, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}

function makeEmptyState() {
  const AIE_DIR = process.env.AIE_RUNTIME_PATH || path.join(__dirname, '..', '..', 'aie');
  const PY = process.env.AIE_PYTHON || 'python';
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-empty-')), 'aie.db');
  const { execFileSync } = require('node:child_process');
  execFileSync(PY, ['-c',
    `import sys; sys.path.insert(0, ${JSON.stringify(path.join(AIE_DIR, 'src'))});\n` +
    `from aie_runtime.persistent_state import PersistentState;\n` +
    `state = PersistentState(db_path=${JSON.stringify(db)});\n` +
    `state.save_all();`],
    { timeout: 60000 });
  return db;
}

test('authority proxy: counts endpoint returns kind counts (empty AIE state → zeros)', async () => {
  const file = makeEmptyState();
  process.env.AIE_STATE_FILE = file;
  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.kinds));
    assert.equal(r.body.kinds.length, 5);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('authority proxy: non-operator gets 403', async () => {
  const gw = new Gateway({
    port: 0,
    bots: { w: { token: 'tok-w', role: 'worker', capabilities: ['fs.read'] } },
    mountFiles: false,
    fnMounts: [authorityProxy],
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-w', '/v2/authority');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'operator_required');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('authority proxy: invalid kind returns 400 with valid list', async () => {
  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority/bogus');
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.valid, ['leases', 'missions', 'admissions', 'outcomes', 'evidence']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('authority proxy: 503 authority_disabled when AIE bridge is absent', async () => {
  const saved = process.env.AIE_RUNTIME_PATH;
  process.env.AIE_RUNTIME_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-missing-')), 'nope');
  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority/leases');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'authority_disabled');
  } finally {
    await new Promise((r) => server.close(r));
    if (saved !== undefined) process.env.AIE_RUNTIME_PATH = saved; else delete process.env.AIE_RUNTIME_PATH;
  }
});
