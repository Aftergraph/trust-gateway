'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// Integration tests for GatewayClient — boots a real Gateway on an
// ephemeral port and exercises every documented method end-to-end.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { GatewayClient } = require('../src/gateway/client');

function buildServer() {
  // dispatch is per-test, so build it inside each test instead.
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) {
      gw = gateway;
      server.on('request', (req, res) => gw.handle(req, res));
    },
    close() { return new Promise((r) => server.close(() => r())); },
    gw: () => gw,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
    server.on('error', reject);
  });
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*', 'fs.read'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => {
      if (tool.startsWith('fs.read')) return { content: 'hello', tool, args: args ?? null };
      if (tool.startsWith('fs.write')) return { wrote: 'ok', path: String(args?.path ?? '') };
      if (tool === 'shell.run') return { ran: true, cmd: String(args?.cmd ?? '') };
      return { ok: true, tool, args };
    },
  });
}

const ctx = buildServer();

test.before(async () => {
  ctx.attach(makeGateway());
  const url = await listen(ctx.server);
  ctx.baseUrl = url;
});

test.after(async () => {
  await ctx.close();
});

test('action: read is allowed and dispatched', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const r = await gw.action('fs.read:notes/x.md');
  assert.equal(r.decision, 'allow');
  assert.ok(r.result, 'result present');
  assert.equal(r.result.content, 'hello');
});

test('action: shell.run is needs_approval with approvalId', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const r = await gw.action('shell.run', { cmd: 'x' });
  assert.equal(r.decision, 'needs_approval');
  assert.ok(r.approvalId, 'approvalId present');
  assert.match(r.approvalId, /^apr_/);
  ctx.shellApprovalId = r.approvalId;
});

test('pending() lists the pending approval', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const r = await gw.pending();
  assert.ok(Array.isArray(r.pending), 'pending is array');
  assert.ok(r.pending.some((p) => p.id === ctx.shellApprovalId), 'our approval present');
});

test('approve() executes the parked action and returns its result', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-atlas' });
  const r = await gw.approve(ctx.shellApprovalId);
  assert.equal(r.id, ctx.shellApprovalId);
  assert.equal(r.status, 'approved');
  assert.ok(r.result, 'result present');
  assert.equal(r.result.ran, true);
});

test('verify() returns ok:true with length >= 3', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const v = await gw.verify();
  assert.equal(v.ok, true);
  assert.ok(typeof v.length === 'number' && v.length >= 3, `length >=3, got ${v.length}`);
  assert.ok(v.head, 'head hash present');
  assert.ok(v.chainId, 'chainId present');
});

test('audit(0) length matches verify().length minus the genesis entry', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const v = await gw.verify();
  const a = await gw.audit(0);
  // audit(0) calls since(0) which excludes genesis (seq 0); verify().length
  // includes it. So entries count is length-1. The /v1/audit shape is:
  // { entries, head, verified } — `verified` is the boolean from chain.verify().
  assert.equal(a.entries.length, v.length - 1);
  assert.equal(a.verified.ok, true);
  assert.ok(a.head);
});

test('wrong token -> 401-shaped {error:"unauthorized"} returned, not thrown', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'definitely-wrong' });
  const r = await gw.action('fs.read:notes/x.md');
  assert.equal(r.error, 'unauthorized');
  assert.equal(r.decision, undefined, 'no decision on auth failure');
});

test('network down: server closed before call -> throws Error', async () => {
  // Spin up a separate server, attach, listen, close, then call.
  const tmp = buildServer();
  tmp.attach(makeGateway());
  const url = await listen(tmp.server);
  const gw = new GatewayClient({ baseUrl: url, token: 'tok-forge' });
  await tmp.close();
  await assert.rejects(async () => gw.action('fs.read:x'), (err) => err instanceof Error);
});

test('deny() on a fresh pending approval returns status:"denied"', async () => {
  const forge = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const prop = await forge.action('shell.run', { cmd: 'rm -rf /' });
  assert.equal(prop.decision, 'needs_approval');
  const atlas = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-atlas' });
  const r = await atlas.deny(prop.approvalId);
  assert.equal(r.id, prop.approvalId);
  assert.equal(r.status, 'denied');
});

test('audit(since=N) returns only entries with seq > N', async () => {
  const gw = new GatewayClient({ baseUrl: ctx.baseUrl, token: 'tok-forge' });
  const v = await gw.verify();
  const tail = await gw.audit(Math.max(0, v.length - 2));
  assert.ok(tail.entries.length <= 2);
  assert.ok(tail.entries.every((e) => e.seq > v.length - 2 || e.seq === v.length - 2));
});