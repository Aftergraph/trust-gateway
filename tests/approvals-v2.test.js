'use strict';
// Approvals-v2 mount tests: batch resolution + queue metrics (operator RBAC).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const mount = require('../src/gateway/mounts/07-approvals-v2.js');
const { ApprovalStore } = require('../src/gateway/approvals.js');

function fakeRes() {
  return { statusCode: null, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
function mkGw({ role = 'operator' } = {}) {
  const store = new ApprovalStore({ gw: {} });
  const audit = [];
  const gw = {
    approvals: store,
    _audit: (e) => audit.push(e),
    __audit: audit,
  };
  return { gw, store, audit };
}
function run(mountFn, gw, method, pathStr, body, botRole = 'operator') {
  const res = fakeRes();
  const url = new URL(`http://x${pathStr}`);
  const payload = body ? JSON.stringify(body) : '';
  const req = {
    method,
    headers: {},
    on(ev, cb) {
      if (ev === 'data' && payload) setImmediate(() => cb(Buffer.from(payload)));
      if (ev === 'end') setImmediate(cb);
      return req;
    },
  };
  return mountFn.handle(gw, req, res, { url, bot: { name: 'op-bot', role: botRole, capabilities: [] } }).then(() => res);
}

test('batch: approve 2, deny 1, unknown id fails per-op without aborting the batch', async () => {
  const { gw, store } = mkGw();
  const a = store.request({ bot: { name: 'forge' }, tool: 'fs.read:x' });
  const b = store.request({ bot: { name: 'forge' }, tool: 'fs.read:y' });
  const c = store.request({ bot: { name: 'forge' }, tool: 'fs.write:z' });

  const res = await run(mount, gw, 'POST', '/v2/approvals/batch', {
    ops: [
      { id: a.id, verdict: 'approve' },
      { id: b.id, verdict: 'approve' },
      { id: c.id, verdict: 'deny' },
      { id: 'apr_ghost', verdict: 'approve' },
    ],
  });
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 4);
  const statuses = Object.fromEntries(out.results.map((r) => [r.id, r.ok]));
  assert.equal(statuses[a.id], true);
  assert.equal(statuses[b.id], true);
  assert.equal(statuses[c.id], true);
  assert.equal(statuses['apr_ghost'], false);
  assert.equal(store.get(a.id).status, 'approved');
  assert.equal(store.get(c.id).status, 'denied');
});

test('batch requires operator (worker -> 403)', async () => {
  const { gw } = mkGw();
  const res = await run(mount, gw, 'POST', '/v2/approvals/batch',
    { ops: [{ id: 'apr_000001', verdict: 'approve' }] }, 'worker');
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'operator_required');
});

test('batch validation: ops required, >100 rejected', async () => {
  const { gw } = mkGw();
  const r1 = await run(mount, gw, 'POST', '/v2/approvals/batch', {});
  assert.equal(r1.statusCode, 400);
  const big = { ops: Array.from({ length: 101 }, () => ({ id: 'x', verdict: 'deny' })) };
  const r2 = await run(mount, gw, 'POST', '/v2/approvals/batch', big);
  assert.equal(r2.statusCode, 400);
  assert.equal(JSON.parse(r2.body).error, 'batch_too_large');
});

test('metrics: queue depth, oldest age, by-tool breakdown', async () => {
  const { gw, store } = mkGw();
  store.request({ bot: { name: 'forge' }, tool: 'fs.read:x' });
  store.request({ bot: { name: 'forge' }, tool: 'fs.read:y' });
  const res = await run(mount, gw, 'GET', '/v2/approvals/metrics', null);
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.queue_depth, 2);
  assert.ok(m.oldest_pending_ms >= 0);
  assert.equal(m.by_tool['fs.read:x'], 1);
  assert.equal(m.by_tool['fs.read:y'], 1);
});

test('metrics requires operator', async () => {
  const { gw } = mkGw();
  const res = await run(mount, gw, 'GET', '/v2/approvals/metrics', null, 'worker');
  assert.equal(res.statusCode, 403);
});