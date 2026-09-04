'use strict';
// HC8 takeover mount tests — mirrors aie e2e_mission_demo_v2.py S4 semantics:
// takeover revokes pending actions, issues subset-only capabilities, escalations
// structurally impossible, audited.

const test = require('node:test');
const assert = require('node:assert');

// The mount exports handle(gw, req, res, ctx); we drive it with a fake gw/res.
function fakeRes() {
  return {
    statusCode: null, body: null,
    writeHead(s) { this.statusCode = s; return this; },
    end(b) { this.body = b; },
  };
}
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const mount = require('../src/gateway/mounts/33-takeover.js');

function fakeGw({ botCanApprove = true, pending = [], capsFromChain = ['read', 'write'] } = {}) {
  const audit = [];
  const approvals = {
    list: () => pending,
    deny: (id, extra) => {
      const row = pending.find((p) => p.id === id);
      if (row) { row.status = 'denied'; row.extra = extra; }
    },
  };
  return {
    _audit: (e) => audit.push(e),
    _approvals: { list: () => pending, deny: approvals.deny.bind(null, pending) },
    _chain: { entries: () => [{ payload: { type: 'action_admitted', bot: 'p1', capabilities: capsFromChain } }] },
    __auditLog: audit,
    __pending: pending,
  };
}
function approvals(pending) {
  return {
    list: () => pending,
    deny: (id, extra) => { const row = pending.find((p) => p.id === id); if (row) { row.status = 'denied'; row.extra = extra; } },
  };
}
let capsFromChain = ['read', 'write'];

function run(mountFn, gw, method, pathStr, body) {
  const res = fakeRes();
  const url = new URL(`http://x${pathStr}`);
  const req = { method, on: (ev, cb) => { if (ev === 'data') {} if (ev === 'end') cb(); }, headers: {} };
  // inject body via readBody shim: our mount uses readBody(req) from ../server —
  // for tests we bypass by making readBody return JSON.stringify(body).
  const origReadBody = require('../src/gateway/server.js').readBody;
  require('../src/gateway/server.js').readBody = async () => JSON.stringify(body || {});
  return mountFn.handle(gw, req, res, { url, bot: { name: 'op-bot' } }).then((r) => {
    require('../src/gateway/server.js').readBody = origReadBody;
    return { res, r };
  });
}

test('takeover issues subset-only capabilities and revokes pending actions', async () => {
  const pending = [{ id: 'a1', status: 'pending', principal_id: 'p1' }];
  const gw = {
    _audit: () => {},
    _approvals: approvals(pending),
    _chain: { entries: () => [{ payload: { type: 'action_admitted', bot: 'p1', capabilities: ['read', 'write'] } }] },
  };
  const { res } = await run(mount, gw, 'POST', '/v2/takeover',
    { principal_id: 'p1', reason: 'human takeover', capabilities: ['read'] });
  const out = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.takeover.revoked_actions.length, 1, 'pending action revoked');
  assert.deepStrictEqual(out.takeover.granted_capabilities, ['read'], 'subset only');
  assert.strictEqual(pending[0].status, 'denied');
});

test('escalation attempt is structurally blocked (request wider than previous)', async () => {
  const gw = {
    _audit: () => {},
    _approvals: approvals([]),
    _chain: { entries: () => [{ payload: { type: 'action_admitted', bot: 'p1', capabilities: ['read'] } }] },
  };
  const { res } = await run(mount, gw, 'POST', '/v2/takeover',
    { principal_id: 'p1', reason: 'test', capabilities: ['read', 'write', 'admin'] });
  const out = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(out.takeover.granted_capabilities, ['read'],
    'only the intersection survives — escalation impossible');
});

test('unknown principal: no previous capabilities → inert takeover (fail-closed)', async () => {
  const gw = {
    _audit: () => {},
    _approvals: approvals([]),
    _chain: { entries: () => [] },
  };
  const { res } = await run(mount, gw, 'POST', '/v2/takeover',
    { principal_id: 'ghost', reason: 'test' });
  const out = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(out.takeover.granted_capabilities, [], 'no caps = inert, never wider');
});

test('validation: principal_id and reason required', async () => {
  const gw = { _audit: () => {}, _approvals: approvals([]), _chain: { entries: () => [] } };
  const r1 = await run(mount, gw, 'POST', '/v2/takeover', { reason: 'x' });
  assert.strictEqual(r1.res.statusCode, 400);
  const r2 = await run(mount, gw, 'POST', '/v2/takeover', { principal_id: 'p1' });
  assert.strictEqual(r2.res.statusCode, 400);
});

test('GET unknown takeover id → uniform 404 (anti-enumeration)', async () => {
  const gw = { _audit: () => {}, _approvals: approvals([]), _chain: { entries: () => [] } };
  const { res } = await run(mount, gw, 'GET', '/v2/takeover/nope', null);
  assert.strictEqual(res.statusCode, 404);
});