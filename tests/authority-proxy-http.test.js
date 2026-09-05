'use strict';
// Authority proxy over HTTP — TDD for the AIE_HTTP slice.
//
// New contract: when AIE_HTTP_URL is set, the proxy fetches the AIE gateway's
// HTTP read endpoints (GET /leases, /missions, /admissions — ab0c2b5) instead
// of spawning aie_authority_bridge.py. Subprocess mode stays as fallback.
//
// Fail-closed rules (unchanged semantics, new transport):
//   - AIE_HTTP_URL set + unreachable  → 502 aie_unreachable
//   - AIE_HTTP_URL set + 401/403      → 502 aie_auth_failed
//   - AIE_HTTP_URL set + 5xx          → 502 aie_error
//   - neither HTTP nor bridge config  → 503 authority_disabled
//
// The HTTP path eliminates the AIE_RUNTIME_PATH/AIE_PYTHON dependency entirely
// and removes the per-request subprocess spawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-http-')), 'gateway.db');
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

function serve(port, handler) {
  return new Promise((r) => server2.listen(port, '127.0.0.1', () => r(server2.address().port)));
}

// ── New HTTP-transport tests ──────────────────────────────────────────

test('authority proxy: AIE_HTTP_URL + healthy gateway → kind data over HTTP (no subprocess)', async () => {
  // Mock AIE gateway serving the ab0c2b5 endpoint shapes
  const mock = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== 'Bearer aie-test-token') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const kind = req.url.replace(/^\//, '');
    if (kind === 'leases') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ leases: [{ id: 'lease1', principal_id: 'p1' }], count: 1 }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const aiePort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  process.env.AIE_HTTP_TOKEN = 'aie-test-token';

  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority/leases');
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 1);
    assert.equal(r.body.leases[0].id, 'lease1');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
    delete process.env.AIE_HTTP_TOKEN;
  }
});

test('authority proxy: AIE_HTTP_URL unreachable → 502 aie_unreachable (fail-closed)', async () => {
  // Port on 127.0.0.1 that almost certainly has no listener
  process.env.AIE_HTTP_URL = 'http://127.0.0.1:1';
  process.env.AIE_HTTP_TOKEN = 'tok';

  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority/leases');
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'aie_unreachable');
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.AIE_HTTP_URL;
    delete process.env.AIE_HTTP_TOKEN;
  }
});

test('authority proxy: AIE_HTTP_URL auth rejected → 502 aie_auth_failed', async () => {
  const mock = http.createServer((req, res) => {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  const aiePort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  process.env.AIE_HTTP_TOKEN = 'wrong-token';

  const gw = makeGateway();
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const r = await fetchJson(port, 'tok-op', '/v2/authority/leases');
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'aie_auth_failed');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
    delete process.env.AIE_HTTP_TOKEN;
  }
});

test('authority proxy: no HTTP and no bridge configured → 503 authority_disabled', async () => {
  const saved = process.env.AIE_RUNTIME_PATH;
  process.env.AIE_RUNTIME_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-http-missing-')), 'nope');
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
