'use strict';
// W0.2/W0.3 mount tests: /v2/proposals lifecycle + correlation + RBAC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mount = require('../src/gateway/mounts/23-missions.js');

function fakeRes() {
  return {
    statusCode: null, body: null,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; },
  };
}

function mkGw({ role = 'worker' } = {}) {
  const auditLog = [];
  return {
    _audit: (e) => auditLog.push(e),
    __audit: auditLog,
  };
}

function run(mountFn, gw, method, pathStr, body, botRole = 'worker') {
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
  return mountFn.handle(gw, req, res, {
    url,
    bot: { name: 'test-bot', role: botRole, capabilities: [] },
  }).then(() => res);
}

test('create -> submit -> approve stamps mission correlation (W0.3)', async () => {
  const gw = mkGw();
  const c = await run(mount, gw, 'POST', '/v2/proposals',
    { proposer: 'agent_1', objective: 'deploy site', channel: 'chat' }, 'worker');
  assert.equal(c.statusCode, 201);
  const created = JSON.parse(c.body).proposal;
  assert.equal(created.status, 'draft');

  const s = await run(mount, gw, 'POST', `/v2/proposals/${created.id}/submit`, {});
  assert.equal(s.statusCode, 200);

  const a = await run(mount, gw, 'POST', `/v2/proposals/${created.id}/approve`,
    { mission_id: 'mission_abc' }, 'operator');
  assert.equal(a.statusCode, 200);
  const approved = JSON.parse(a.body).proposal;
  assert.equal(approved.converted_to_mission_id, 'mission_abc', 'W0.3 correlation');
});

test('worker cannot approve (403 operator_required)', async () => {
  const gw = mkGw();
  const c = await run(mount, gw, 'POST', '/v2/proposals', { proposer: 'a', objective: 'x' });
  const id = JSON.parse(c.body).proposal.id;
  await run(mount, gw, 'POST', `/v2/proposals/${id}/submit`, {});
  const a = await run(mount, gw, 'POST', `/v2/proposals/${id}/approve`, {}, 'worker');
  assert.equal(a.statusCode, 403);
  assert.equal(JSON.parse(a.body).error, 'operator_required');
});

test('invalid lifecycle transitions -> 409', async () => {
  const gw = mkGw();
  const c = await run(mount, gw, 'POST', '/v2/proposals', { proposer: 'a', objective: 'x' });
  const id = JSON.parse(c.body).proposal.id;
  const a = await run(mount, gw, 'POST', `/v2/proposals/${id}/approve`, {}, 'operator');
  assert.equal(a.statusCode, 409, 'cannot approve a draft');
});

test('GET unknown id -> uniform 404', async () => {
  const gw = mkGw();
  const res = await run(mount, gw, 'GET', '/v2/proposals/ghost', null);
  assert.equal(res.statusCode, 404);
});

test('audit entries recorded for stateful decisions', async () => {
  const gw = mkGw();
  const c = await run(mount, gw, 'POST', '/v2/proposals', { proposer: 'a', objective: 'x' });
  const id = JSON.parse(c.body).proposal.id;
  await run(mount, gw, 'POST', `/v2/proposals/${id}/submit`, {});
  const types = gw.__audit.map((a) => a.type);
  assert.ok(types.includes('proposal_created'));
  assert.ok(types.includes('proposal_submitted'));
});