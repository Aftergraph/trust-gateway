'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Gateway } = require('../src/gateway/server');
const { canApprove } = require('../src/gateway/server');

const { EventEmitter } = require('node:events');

function makeGateway(dispatch) {
  return new Gateway({
    bots: {
      // operator: role === 'operator'
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: [] },
      // worker: role === 'worker', no '*', no 'approval.decide'
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*', 'fs.read'] },
      // wildcard admin: capabilities contains '*'
      admin: { token: 'tok-admin', role: 'worker', capabilities: ['*'] },
      // capability-granted operator
      capop: { token: 'tok-capop', role: 'worker', capabilities: ['approval.decide'] },
      // unknown role, no caps, no wildcard -> denied (fail closed)
      rogue: { token: 'tok-rogue', role: 'analyst', capabilities: ['fs.read'] },
      // no role at all, no caps -> denied (fail closed)
      plain: { token: 'tok-plain', capabilities: ['fs.read'] },
    },
    dispatch,
  });
}

function mockReqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: 'Bearer ' + token } : {};
  req.on = EventEmitter.prototype.on;
  let statusCode = null, bodyStr = null;
  const res = {
    writeHead(s, h) { statusCode = s; this._h = h; },
    end(b) { bodyStr = b; },
  };
  if (body !== undefined && body !== null) process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return { req, res, getStatus: () => statusCode, getBody: () => JSON.parse(bodyStr) };
}

// Helper: create a pending approval for shell.run (needs_approval class).
async function createPending(gw) {
  const r1 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run', args: { cmd: 'deploy.sh' } }), 'tok-forge');
  await gw.handle(r1.req, r1.res);
  assert.equal(r1.getStatus(), 202);
  return r1.getBody().approvalId;
}

test('canApprove: operator true', () => {
  assert.equal(canApprove({ role: 'operator' }), true);
});

test('canApprove: * capability true', () => {
  assert.equal(canApprove({ role: 'worker', capabilities: ['*'] }), true);
});

test('canApprove: approval.decide capability true', () => {
  assert.equal(canApprove({ role: 'worker', capabilities: ['approval.decide'] }), true);
});

test('canApprove: worker without caps false', () => {
  assert.equal(canApprove({ role: 'worker', capabilities: ['fs.read'] }), false);
});

test('canApprove: unknown role false', () => {
  assert.equal(canApprove({ role: 'analyst', capabilities: ['fs.read'] }), false);
});

test('canApprove: null bot false', () => {
  assert.equal(canApprove(null), false);
});

test('operator can approve → 200, dispatched, chain verified', async () => {
  let executed = null;
  const gw = makeGateway(async (_bot, tool, args) => { executed = { tool, args }; return { ran: true }; });
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-atlas');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 200);
  assert.equal(r.getBody().status, 'approved');
  assert.deepEqual(executed, { tool: 'shell.run', args: { cmd: 'deploy.sh' } });
  assert.equal(gw.chain.verify().ok, true);
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'action_executed_after_approval'));
  assert.equal(gw.approvals.get(id).status, 'approved');
});

test('worker cannot approve → 403 + audit entry + chain still verifies', async () => {
  const gw = makeGateway();
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-forge');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 403);
  assert.equal(r.getBody().error, 'operator_required');

  // audit entry exists with type + metadata, NO args leaked
  const forb = gw.chain.entries.find((e) => e.payload.type === 'approval_forbidden');
  assert.ok(forb, 'approval_forbidden audit entry missing');
  assert.equal(forb.payload.approvalId, id);
  assert.equal(forb.payload.bot, 'forge');
  assert.equal(forb.payload.tool, 'shell.run');
  const serialized = JSON.stringify(forb.payload);
  assert.ok(!serialized.includes('deploy.sh'), 'worker approval must not leak args');

  // chain must remain valid (tamper-evident seal intact)
  assert.equal(gw.chain.verify().ok, true);

  // the pending approval is untouched and NOT resolved
  const pending = gw.approvals.get(id);
  assert.equal(pending.status, 'pending');
});

test('wildcard (*) capability can approve', async () => {
  let executed = null;
  const gw = makeGateway(async (_bot, tool, args) => { executed = { tool, args }; return { ran: true }; });
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-admin');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 200);
  assert.equal(gw.approvals.get(id).status, 'approved');
  assert.deepEqual(executed, { tool: 'shell.run', args: { cmd: 'deploy.sh' } });
  assert.equal(gw.chain.verify().ok, true);
});

test('unknown-role bot cannot approve → 403 + audit', async () => {
  const gw = makeGateway();
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/deny`, '{}', 'tok-rogue');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 403);
  assert.equal(r.getBody().error, 'operator_required');
  const forb = gw.chain.entries.find((e) => e.payload.type === 'approval_forbidden' && e.payload.approvalId === id);
  assert.ok(forb);
  assert.equal(forb.payload.bot, 'rogue');
  assert.equal(forb.payload.tool, 'shell.run');
  assert.equal(gw.approvals.get(id).status, 'pending');
  assert.equal(gw.chain.verify().ok, true);
});

test('no-role no-wildcard bot is denied (fail closed)', async () => {
  const gw = makeGateway();
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-plain');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 403);
  assert.equal(r.getBody().error, 'operator_required');
  const forb = gw.chain.entries.find((e) => e.payload.type === 'approval_forbidden' && e.payload.approvalId === id);
  assert.ok(forb);
  assert.equal(forb.payload.bot, 'plain');
  assert.equal(gw.approvals.get(id).status, 'pending');
});

test('approval.decide capability bot can approve', async () => {
  let executed = null;
  const gw = makeGateway(async (_bot, tool, args) => { executed = { tool, args }; return { ran: true }; });
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-capop');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 200);
  assert.equal(gw.approvals.get(id).status, 'approved');
  assert.equal(gw.chain.verify().ok, true);
});

test('worker denied on /deny endpoint too', async () => {
  const gw = makeGateway();
  const id = await createPending(gw);

  const r = mockReqRes('POST', `/v1/approvals/${id}/deny`, '{}', 'tok-forge');
  await gw.handle(r.req, r.res);

  assert.equal(r.getStatus(), 403);
  assert.equal(r.getBody().error, 'operator_required');
  assert.equal(gw.approvals.get(id).status, 'pending');
  assert.equal(gw.chain.verify().ok, true);
});

test('non-existent approval still records forbidden audit for worker', async () => {
  const gw = makeGateway();
  const r = mockReqRes('POST', `/v1/approvals/apr_999999/approve`, '{}', 'tok-forge');
  await gw.handle(r.req, r.res);
  assert.equal(r.getStatus(), 403);
  const forb = gw.chain.entries.find((e) => e.payload.type === 'approval_forbidden');
  assert.ok(forb);
  assert.equal(forb.payload.approvalId, 'apr_999999');
  assert.equal(forb.payload.tool, null); // no record -> no leak
  assert.equal(gw.chain.verify().ok, true);
});
