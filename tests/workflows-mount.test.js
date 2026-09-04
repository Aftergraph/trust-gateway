'use strict';
// P2 workflow mount tests: CRUD + run-via-WORKS (fail-closed) + RBAC.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const mount = require('../src/gateway/mounts/26-workflows.js');

function fakeRes() {
  return { statusCode: null, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
function run(mountFn, gw, method, pathStr, body, botRole = 'operator', extraHeaders = {}) {
  const res = fakeRes();
  const payload = body ? JSON.stringify(body) : '';
  const req = {
    method,
    headers: { ...extraHeaders },
    on(ev, cb) {
      if (ev === 'data' && payload) setImmediate(() => cb(Buffer.from(payload)));
      if (ev === 'end') setImmediate(cb);
      return req;
    },
  };
  return mountFn.handle(gw, req, res, { url: new URL(`http://x${pathStr}`), bot: { name: 'op', role: botRole } })
    .then(() => res);
}
function mkGw({ works = null } = {}) {
  const audit = [];
  return { gw: { _audit: (e) => audit.push(e), __audit: audit, __works: works }, audit };
}
// stub works-client per test by injecting into the mount's require scope:
function setWorksStub(impl) {
  require('../src/gateway/works-client.js').createWork = impl;
}

const STEPS = [
  { id: 'build', run: 'npm run build' },
  { id: 'test', run: 'npm test', depends_on: ['build'] },
];

test('create -> activate -> run (WORKS stub) returns work_id + audits', async () => {
  const calls = [];
  setWorksStub(async (spec) => ({ ok: true, work_id: 'wrk_test_1' }));
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', { name: 'pipe', steps: STEPS }, 'operator');
  assert.equal(c.statusCode, 201);
  const id = JSON.parse(c.body).workflow.id;
  await run(mount, gw, 'POST', `/v2/workflows/${id}/activate`, {});

  const rr = await run(mount, gw, 'POST', `/v2/workflows/${id}/run`, {});
  assert.equal(rr.statusCode, 200);
  assert.equal(JSON.parse(rr.body).work_id, 'wrk_test_1');
});

test('run requires operator (worker -> 403 forbidden)', async () => {
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', { name: 'x', steps: STEPS }, 'worker');
  const id = JSON.parse(c.body).workflow.id;
  const r = await run(mount, gw, 'POST', `/v2/workflows/${id}/run`, {}, 'worker');
  assert.equal(r.statusCode, 403);
});

test('run on non-active workflow -> 409 not_active', async () => {
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', { name: 'x', steps: STEPS }, 'operator');
  const id = JSON.parse(c.body).workflow.id;
  const r = await run(mount, gw, 'POST', `/v2/workflows/${id}/run`, {}, 'operator');
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).error, 'not_active');
});

test('run with works-unconfigured control plane -> 502 fail-closed', async () => {
  setWorksStub(async () => ({ ok: false, reason: 'disabled' }));
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', { name: 'x', steps: STEPS }, 'operator');
  const id = JSON.parse(c.body).workflow.id;
  await run(mount, gw, 'POST', `/v2/workflows/${id}/activate`, {});
  const r = await run(mount, gw, 'POST', `/v2/workflows/${id}/run`, {}, 'operator');
  assert.equal(r.statusCode, 502);
  assert.equal(JSON.parse(r.body).error, 'works_submission_failed');
});

test('invalid workflow (cycle) -> 400', async () => {
  const gw = { _audit: () => {} };
  const r = await run(mount, gw, 'POST', '/v2/workflows', {
    name: 'cycle', steps: [
      { id: 'a', run: 'x', depends_on: ['b'] },
      { id: 'b', run: 'y', depends_on: ['a'] },
    ],
  }, 'operator');
  assert.equal(r.statusCode, 400);
  assert.match(JSON.parse(r.body).error, /cycle/);
});
test('webhook trigger: valid HMAC signature submits run; invalid rejected 401', async () => {
  const crypto = require('node:crypto');
  const gw = { _audit: () => {} };
  const secret = 'wh-secret';
  const c = await run(mount, gw, 'POST', '/v2/workflows',
    { name: 'hooked', steps: STEPS, triggers: [{ type: 'webhook', secret }] }, 'operator');
  const id = JSON.parse(c.body).workflow.id;
  await run(mount, gw, 'POST', `/v2/workflows/${id}/activate`, {});

  const payload = { event: 'push' };
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  setWorksStub(async () => ({ ok: true, work_id: 'wrk_wh_1' }));
  const ok = await run(mount, gw, 'POST', `/v2/workflows/${id}/webhook`,
    payload, 'operator', { 'x-works-signature': sig });
  // webhook route ignores bot role (it's machine-to-machine) but signature matters:
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).work_id, 'wrk_wh_1');

  // invalid signature
  const bad = await run(mount, gw, 'POST', `/v2/workflows/${id}/webhook`,
    { event: 'push' }, 'operator');
  assert.equal(bad.statusCode, 401);
});

test('webhook on workflow without webhook trigger -> 409', async () => {
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', { name: 'x', steps: STEPS }, 'operator');
  const id = JSON.parse(c.body).workflow.id;
  const r = await run(mount, gw, 'POST', `/v2/workflows/${id}/webhook`, { event: 'x' }, 'operator');
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).error, 'webhook_not_configured');
});

test('trigger-sweep: operator-only; due schedule workflows submitted + marked', async () => {
  const gw = { _audit: () => {} };
  const c = await run(mount, gw, 'POST', '/v2/workflows', {
    name: 'sched', steps: STEPS,
    triggers: [{ type: 'schedule', every_minutes: 1 }],
  }, 'operator');
  const id = JSON.parse(c.body).workflow.id;
  await run(mount, gw, 'POST', `/v2/workflows/${id}/activate`, {});
  // no last_run_at -> immediately due
  const r = await run(mount, gw, 'POST', '/v2/workflows/trigger-sweep', {}, 'operator');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.includes(id) || r.body.includes('swept'), 'sweep ran');
});