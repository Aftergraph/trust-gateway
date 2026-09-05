'use strict';
// H6 E2E — POST /v2/authority/leases/:id/revoke via TG gateway.
// Mock AIE HTTP server der matcher AIE's autoritative kontrakt (ab0c2b5):
//   POST /revocations  { lease_id }   → { revoked, replicated }
//   GET  /leases                      → { leases: [...], count }
// Gateway-harness: samme pattern som H1 (executions-verify.test.js).
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

// Standard lease-database mock'en svarer med (AIE-kontrakt: { leases, count })
const LEASES = [
  { id: 'lease_active_1', revoked: false, depth: 0, budget_remaining: 100, expires_at: null },
  { id: 'lease_already_revoked', revoked: true, depth: 0, budget_remaining: 0, expires_at: null },
  { id: 'lease_expired', revoked: false, depth: 0, budget_remaining: 10, expires_at: '2020-01-01T00:00:00Z' },
];

function createMockAIE(revokeHandler, { persist = true } = {}) {
  const state = LEASES.map((l) => ({ ...l }));
  return http.createServer((req2, res) => {
    let body = '';
    req2.on('data', (c) => { body += c; });
    req2.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req2.method === 'POST' && req2.url === '/revocations') {
        if (persist) {
          const parsed = JSON.parse(body || '{}');
          const found = state.find((l) => l.id === parsed.lease_id);
          if (found) found.revoked = true;  // AIE ville persistere revocationen
        }
        return revokeHandler(req2, res, body);
      }
      if (req2.method === 'GET' && req2.url === '/leases') {
        return res.end(JSON.stringify({ leases: state, count: state.length }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
}

async function startMock(revokeHandler, options) {
  const mock = createMockAIE(revokeHandler, options);
  const port = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
  return { mock, port };
}

// --- Tests ---

test('H6: operator + valid reason -> 200 ok, lease revoked, read-back', async () => {
  const revokeCalls = [];
  const { mock, port: aiePort } = await startMock((req2, res, body) => {
    revokeCalls.push({ url: req2.url, body: JSON.parse(body || '{}') });
    res.end(JSON.stringify({ revoked: 'lease_active_1', replicated: 0 }));
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
    assert.equal(revokeCalls[0].url, '/revocations');
    assert.equal(revokeCalls[0].body.lease_id, 'lease_active_1');
    assert.ok(r.body.lease, 'read-back included');
    assert.equal(r.body.lease.id, 'lease_active_1');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: non-operator -> 403', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ revoked: 'x' })));
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

test('H6: tom reason -> 400 reason_required', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ revoked: 'x' })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: '   ' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'reason_required');
    const r2 = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', {});
    assert.equal(r2.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: lease findes ikke -> 404 lease_not_found (pre-check)', async () => {
  const revokeCalls = [];
  const { mock, port: aiePort } = await startMock((req2, res) => {
    revokeCalls.push(1);
    res.end(JSON.stringify({ revoked: 'ghost' }));
  });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/ghost_lease/revoke', 'tok-op', { reason: 'x' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'lease_not_found');
    assert.equal(revokeCalls.length, 0, 'AIE revoke IKKE kaldt for ukendt lease');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: allerede revoked -> 409 already_revoked (pre-check, ingen falsk success)', async () => {
  const revokeCalls = [];
  const { mock, port: aiePort } = await startMock((req2, res) => {
    revokeCalls.push(1);
    res.end(JSON.stringify({ revoked: 'lease_already_revoked' }));
  });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_already_revoked/revoke', 'tok-op', { reason: 'dup' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'already_revoked');
    assert.equal(revokeCalls.length, 0, 'AIE revoke IKKE kaldt for allerede-revokeret lease');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: udløbet lease -> 409 lease_expired (pre-check)', async () => {
  const revokeCalls = [];
  const { mock, port: aiePort } = await startMock((req2, res) => {
    revokeCalls.push(1);
    res.end(JSON.stringify({ revoked: 'lease_expired' }));
  });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_expired/revoke', 'tok-op', { reason: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'lease_expired');
    assert.equal(revokeCalls.length, 0, 'AIE revoke IKKE kaldt for udløbet lease');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: AIE unreachable -> 502 aie_unreachable', async () => {
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

test('H6: AIE auth rejected -> 502 aie_auth_failed', async () => {
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

test('H6: read-back bekræfter ikke revoked -> 502 revoke_unconfirmed', async () => {
  // AIE svarer 200 på revoke, men GET /leases viser stadig revoked:false
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ revoked: 'lease_active_1' })), { persist: false });
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'x' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'revoke_unconfirmed');
    assert.equal(r.body.ok, undefined, 'ingen falsk success');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: ingen AIE_HTTP_URL -> 503 authority_disabled', async () => {
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
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ revoked: 'x' })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'GET', '/v2/authority/leases', 'tok-op');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.leases), 'leases listed (AIE-kontrakt {leases})');
    assert.equal(r.body.count, LEASES.length);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

test('H6: revoke auditers i hash-chain (governance-seal)', async () => {
  const { mock, port: aiePort } = await startMock((_, res) => res.end(JSON.stringify({ revoked: 'lease_active_1' })));
  process.env.AIE_HTTP_URL = `http://127.0.0.1:${aiePort}`;
  const gw = makeGateway();
  const auditEvents = [];
  gw.on('audit', (e) => auditEvents.push(e));
  const { server, port } = await boot(gw);
  try {
    await req(port, 'POST', '/v2/authority/leases/lease_active_1/revoke', 'tok-op', { reason: 'audit-test' });
    const revokeAudits = auditEvents.filter((e) => e.payload && e.payload.type === 'authority_lease_revoke');
    assert.equal(revokeAudits.length, 1, 'revoke auditeret i chain');
    assert.equal(revokeAudits[0].payload.lease_id, 'lease_active_1');
    assert.equal(revokeAudits[0].payload.reason, 'audit-test');
    assert.equal(revokeAudits[0].payload.lease_readback_revoked, true);
    assert.ok(revokeAudits[0].hash, 'sealed entry hash');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.AIE_HTTP_URL;
  }
});

