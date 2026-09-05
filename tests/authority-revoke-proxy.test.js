'use strict';
// H6 E2E — POST /v2/authority/leases/:id/revoke via TG gateway.
// Mock AIE HTTP server (POST /leases/:id/revoke + GET /leases read-back).
// Gateway-harness: samme pattern som H1 (executions-verify.test.js).
//
// Dækker:
// 1. Operator med valid reason → 200 ok, lease revoked, read-back
// 2. Non-operator → 403
// 3. Tom reason → 400
// 4. AIE unreachable → 502
// 5. AIE auth rejected → 502
// 6. Duplikat revoke (409) → TG videresender ærligt
// 7. Ingen AIE_HTTP_URL → 503 authority_disabled
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-h6-'));
process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const authorityProxy = require('../src/gateway/mounts/132-authority-proxy.js');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      viewer: { token: 'tok-viewer', role: 'viewer', capabilities: [] },
    },
    mountFiles: false,
    fnMounts: [authorityProxy],
  });
}

function req(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function boot(gw) {
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, port };
}

// Mock AIE: modtager POST /leases/:id/revoke + GET /leases til read-back
function createMockAIE(revokeHandler) {
  return http.createServer((req2, res) => {
    let body = '';
    req2.on('data', (c) => { body += c; });
    req2.on('end', () => {
      res.setHeader('content-type', 'application/json');
      // POST /leases/:id/revoke
      if (req2.method === 'POST' && /^\/leases\/[^/]+\/revoke$/.test(req2.url)) {
        return revokeHandler(req2, res, body);
      }
      // GET /leases → read-back
      if (req2.method === 'GET' && req2.url === '/leases') {
        return res.end(JSON.stringify({ items: [
          { id: 'lease_active_1', revoked: false, depth: 0, budget_remaining: 100 },
          { id: 'lease_already_revoked', revoked: true, depth: 0, budget_remaining: 0 },
        ] }));
      }
      // GET /leases/:id (enkelt)
      if (req2.method === 'GET' && /^\/leases\/[^/]+$/.test(req2.url)) {
        const id = req2.url.split('/')[2];
        if (id === 'lease_already_revoked') {
          return res.end(JSON.stringify({ id, revoked: true }));
        }
        return res.end(JSON.stringify({ id, revoked: false }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
}

async function startMock(revokeHandler) {
  const mock = createMockAIE(revokeHandler);
  const port = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
  return { mock, port };
}

// --- Tests ---

test('H6: operator + valid reason → 200 ok, lease revoked, read-back', async () => {
  const revokeCalls = [];
  const { mock, port: aiePort } = await startMock((req2, res, body) => {
    revokeCalls.push({ url: req2.url, body: JSON.parse(body || '{}') });
    res.end(JSON.stringify({ ok: true }));
  });

  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'test-revoke' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.ok, true, 'revoke success');
    assert.equal(r.body.revoked, true, 'lease revoked');
    assert.equal(r.body.lease_id, 'lease_active_1');
    assert.equal(r.body.reason, 'test-revoke');
    assert.equal(revokeCalls.length, 1, 'AIE revoke called once');
    assert.match(revokeCalls[0].url, /\/leases\/lease_active_1\/revoke/);
    assert.equal(revokeCalls[0].body.reason, 'test-revoke');
    // Read-back: lease.readBack returnerer objektet fra GET /leases
    assert.ok(r.body.lease, 'read-back included');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: non-operator → 403', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ ok: true })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-viewer', { reason: 'test' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'operator_required');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: tom reason → 400 reason_required', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ ok: true })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    // tom reason
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: '   ' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'reason_required');
    // ingen body
    const r2 = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', {});
    assert.equal(r2.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: AIE unreachable → 502 aie_unreachable', async () => {
  // Ingen mock starter → port 0 er lukket
  process.env.AIE_HTTP_URL = 'http://127.0.0.1:1';

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'test' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'aie_unreachable');
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: AIE auth rejected → 502 aie_auth_failed', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'test' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'aie_auth_failed');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: duplikat revoke (409) → TG videresender ærligt', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'already_revoked' }));
  });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_already_revoked/revoke', 'tok-op', { reason: 'duplicate' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'already_revoked');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: ingen AIE_HTTP_URL → 503 authority_disabled', async () => {
  delete process.env.AIE_HTTP_URL;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'test' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'authority_disabled');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('H6: GET /v2/authority leases proxy virker fortsat (regression)', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ ok: true })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    // GET leases (læsning) skal stadig fungere
    const r = await req(port, 'GET', '/v2/authority/leases', 'tok-op');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items), 'leases listed');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: revoke auditers i hash-chain (governance-seal)', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ ok: true })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;

  const gw = makeGateway();
  const auditEvents = [];
  gw.on('audit', (e) => auditEvents.push(e));
  const { server, port } = await boot(gw);
  try {
    await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'audit-test' });
    // Chain entries: { seq, ts, payload: { type, ... }, hash }
    const revokeAudits = auditEvents.filter((e) => e.payload && e.payload.type === 'authority_lease_revoke');
    assert.equal(revokeAudits.length, 1, 'revoke auditeret i chain');
    assert.equal(revokeAudits[0].payload.lease_id, 'lease_active_1');
    assert.equal(revokeAudits[0].payload.reason, 'audit-test');
    assert.ok(revokeAudits[0].hash, 'sealed entry hash');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});
