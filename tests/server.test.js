'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');

function makeGateway(dispatch = async (bot, tool) => ({ ok: true, tool })) {
  return new Gateway({
    bots: {
      forge: { token: 'tok-forge', capabilities: ['fs.write:*', 'fs.read'] },
      auditor: { token: 'tok-auditor', capabilities: [] },
    },
    dispatch,
  });
}

const { EventEmitter } = require('node:events');

function mockReqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.on = EventEmitter.prototype.on;
  let statusCode = null, bodyStr = null;
  const res = {
    writeHead(s, h) { statusCode = s; this._h = h; },
    end(b) { bodyStr = b; },
  };
  // feed body asynchronously so readBody's listeners attach first
  if (body !== undefined && body !== null) process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return { req, res, getStatus: () => statusCode, getBody: () => JSON.parse(bodyStr) };
}

test('unauthenticated request → 401 + audited', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', '{}', null);
  await gw.handle(req, res);
  assert.equal(getStatus(), 401);
  assert.equal(gw.chain.entries[1].payload.type, 'auth_rejected');
});

test('unknown token → 401', async () => {
  const gw = makeGateway();
  const { req, res, getStatus } = mockReqReqHack('POST', '/v1/actions', '{}', 'wrong-token');
  function mockReqReqHack(...a) { return mockReqRes(...a); }
  await gw.handle(req, res);
  assert.equal(getStatus(), 401);
});

test('read action: allowed + dispatched + audited', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:notes/x.md' }), 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getBody().decision, 'allow');
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'action_executed'));
});

test('write without capability → 202 needs_approval', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.write:new.txt' }), 'tok-auditor');
  await gw.handle(req, res);
  assert.equal(getStatus(), 202);
  const body = getBody();
  assert.equal(body.decision, 'needs_approval');
  assert.ok(body.approvalId.startsWith('apr_'));
});

test('write with capability → dispatched', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.write:out.txt', args: { content: 'hi' } }), 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getBody().decision, 'allow');
});

test('destructive tool NEVER auto-executes (even with capability)', async () => {
  let executed = false;
  const gw = makeGateway(async () => { executed = true; return {}; });
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run', args: 'rm -rf /' }), 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 202);
  assert.equal(getBody().decision, 'needs_approval');
  assert.equal(executed, false);
});

test('approval flow: request → approve → dispatched', async () => {
  let executed = null;
  const gw = makeGateway(async (bot, tool, args) => { executed = { tool, args }; return { ran: true }; });
  // 1. propose destructive
  const r1 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run', args: { cmd: 'deploy.sh' } }), 'tok-forge');
  await gw.handle(r1.req, r1.res);
  const approvalId = r1.getBody().approvalId;
  assert.ok(approvalId);
  assert.equal(executed, null);
  // 2. approve (auditor is an authenticated principal; in production = operator)
  const r2 = mockReqRes('POST', `/v1/approvals/${approvalId}/approve`, '{}', 'tok-auditor');
  await gw.handle(r2.req, r2.res);
  assert.equal(r2.getStatus(), 200);
  assert.deepEqual(executed, { tool: 'shell.run', args: { cmd: 'deploy.sh' } });
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'action_executed_after_approval'));
});

test('approval deny → never dispatched', async () => {
  let executed = false;
  const gw = makeGateway(async () => { executed = true; });
  const r1 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.delete:data' }), 'tok-forge');
  await gw.handle(r1.req, r1.res);
  const id = r1.getBody().approvalId;
  const r2 = mockReqRes('POST', `/v1/approvals/${id}/deny`, '{}', 'tok-auditor');
  await gw.handle(r2.req, r2.res);
  assert.equal(executed, false);
  assert.equal(gw.approvals.get(id).status, 'denied');
});

test('secret args length-only in audit (value never stored)', async () => {
  const gw = makeGateway();
  const secretArgs = { key: 'SUPER-SECRET-VALUE-abc123' };
  const { req, res } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'secret.read:vault', args: secretArgs }), 'tok-forge');
  await gw.handle(req, res); // 202 needs approval (capability missing → deny path actually)
  const serialized = JSON.stringify(gw.chain.entries);
  assert.ok(!serialized.includes('SUPER-SECRET-VALUE'));
  assert.ok(serialized.includes('argsLength'));
});

test('audit verify endpoint returns ok', async () => {
  const gw = makeGateway();
  const { req, res, getStatus, getBody } = mockReqRes('GET', '/v1/audit/verify', null, 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getBody().ok, true);
});

test('bad json → 400', async () => {
  const gw = makeGateway();
  const { req, res, getStatus } = mockReqRes('POST', '/v1/actions', 'not-json', 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 400);
});

test('unknown path → 404', async () => {
  const gw = makeGateway();
  const { req, res, getStatus } = mockReqRes('GET', '/v1/nothing', null, 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 404);
});

test('write-ahead: decision audited before dispatch', async () => {
  const gw = makeGateway();
  const { req, res } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x' }), 'tok-forge');
  await gw.handle(req, res);
  const seqs = gw.chain.entries.map((e) => [e.payload.type, e.seq]);
  const decisionSeq = seqs.find(([t]) => t === 'action_decision')[1];
  const execSeq = seqs.find(([t]) => t === 'action_executed')[1];
  assert.ok(decisionSeq < execSeq);
});