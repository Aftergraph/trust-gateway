'use strict';
// Slice 2 acceptance — per-bot spend caps.
// Acceptance: A-001..A-008. All drive the real Gateway via HTTP (or mock
// req/res for the in-process path) to exercise both the BudgetStore and
// the orchestrator-owned guard in server.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Gateway } = require('../src/gateway/server');
const { BudgetStore } = require('../src/gateway/budgets');

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-bgt-')), name);
}

function makeGateway({ dispatch = async () => ({ ok: true }), budgets = null, now = () => Date.now() } = {}) {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*', 'fs.read'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch,
    budgets,
    now,
  });
}

function mockReqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.on = EventEmitter.prototype.on;
  let statusCode = null, bodyStr = null;
  const res = {
    writeHead(s) { statusCode = s; },
    end(b) { bodyStr = b; },
  };
  if (body !== undefined && body !== null) process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return { req, res, getStatus: () => statusCode, getBody: () => JSON.parse(bodyStr) };
}

function buildServer(gw) {
  const server = http.createServer();
  server.on('request', (req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ── A-001: consume under limit → dispatch proceeds ────────────────────────
test('A-001 consume under limit: dispatch proceeds', async () => {
  const store = new BudgetStore({ file: tmpfile('a001.json') });
  store.setLimit('forge', { maxActionsPerDay: 5 });
  let dispatched = 0;
  const gw = makeGateway({ budgets: store, dispatch: async (bot, tool) => { dispatched += 1; return { ok: true, tool }; } });
  const { req, res, getStatus, getBody } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x' }), 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  assert.equal(getBody().decision, 'allow');
  assert.equal(dispatched, 1);
  // consume was recorded
  assert.equal(store.getUsage('forge').usedToday, 1);
});

// ── A-002: limit reached → 402 + audit type:'budget_denied' sealed ──────
test('A-002 limit reached: 402 budget_exhausted + budget_denied audit', async () => {
  const store = new BudgetStore({ file: tmpfile('a002.json') });
  store.setLimit('forge', { maxActionsPerDay: 1 });
  let dispatched = 0;
  const gw = makeGateway({ budgets: store, dispatch: async () => { dispatched += 1; return { ok: true }; } });

  // 1st: allow + consume
  const r1 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x' }), 'tok-forge');
  await gw.handle(r1.req, r1.res);
  assert.equal(r1.getStatus(), 200);

  // 2nd: budget exhausted
  const r2 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:y' }), 'tok-forge');
  await gw.handle(r2.req, r2.res);
  assert.equal(r2.getStatus(), 402);
  assert.equal(r2.getBody().decision, 'deny');
  assert.equal(r2.getBody().error, 'budget_exhausted');
  assert.equal(dispatched, 1, 'dispatch must NOT have been called a second time');

  // audit chain: budget_denied sealed (chain still verifies)
  const denied = gw.chain.entries.find((e) => e.payload.type === 'budget_denied');
  assert.ok(denied, 'budget_denied audit entry must exist');
  assert.equal(denied.payload.bot, 'forge');
  assert.equal(denied.payload.tool, 'fs.read:y');
  assert.equal(gw.chain.verify().ok, true, 'chain still sealed after budget_denied');
});

// ── A-003: corrupt budgets.json → Gateway construction throws ──────────
test('A-003 corrupt budgets.json: Gateway construction fails closed', () => {
  const f = tmpfile('a003.json');
  fs.writeFileSync(f, '{not valid json');
  assert.throws(
    () => makeGateway({ budgets: new BudgetStore({ file: f }) }),
    /refusing to load/,
  );
});

// ── A-004: non-approver PUT → 403 ────────────────────────────────────────
test('A-004 non-approver PUT /v2/budgets/<bot> → 403 + budget_forbidden audit', async () => {
  const store = new BudgetStore({ file: tmpfile('a004.json') });
  const gw = makeGateway({ budgets: store });
  const { server, url } = await buildServer(gw);
  try {
    const res = await fetch(`${url}/v2/budgets/forge`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-forge', 'content-type': 'application/json' },
      body: JSON.stringify({ maxActionsPerDay: 10 }),
    });
    assert.equal(res.status, 403);
    const audit = gw.chain.entries.find((e) => e.payload.type === 'budget_forbidden');
    assert.ok(audit, 'budget_forbidden audit entry must exist');
    assert.equal(audit.payload.bot, 'forge');
    assert.equal(audit.payload.by, 'forge');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── A-005: day rollover with injected now() → counters reset ────────────
test('A-005 day rollover: injected now() resets counters, dispatch allowed', async () => {
  let t = 1_700_000_000_000; // fixed origin
  const now = () => t;
  const store = new BudgetStore({ now, file: tmpfile('a005.json') });
  store.setLimit('forge', { maxActionsPerDay: 2 });
  // consume the two allowed actions for "today"
  assert.equal(store.consume('forge').ok, true);
  assert.equal(store.consume('forge').ok, true);
  // third consume is exhausted
  const c2 = store.consume('forge');
  assert.equal(c2.ok, false);
  assert.equal(c2.reason, 'budget_exhausted');

  // jump forward 25h → new UTC day
  t += 25 * 60 * 60 * 1000;
  const c3 = store.consume('forge');
  assert.equal(c3.ok, true, 'after day rollover the cap resets');
  assert.equal(c3.remaining, 1);

  // and the dispatcher path also re-allows (end-to-end through Gateway)
  const gw = makeGateway({ budgets: store, now, dispatch: async () => ({ ok: true }) });
  const { req, res, getStatus } = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:y' }), 'tok-forge');
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
});

// ── A-006: bot without budget entry → unlimited ─────────────────────────
test('A-006 bot without budget entry: unlimited consume', async () => {
  const store = new BudgetStore({ file: tmpfile('a006.json') });
  store.setLimit('forge', { maxActionsPerDay: 1 });
  // 'atlas' has no entry configured
  for (let i = 0; i < 50; i += 1) {
    const r = store.consume('atlas');
    assert.equal(r.ok, true, `atlas action #${i + 1} must be unlimited`);
    assert.equal(r.unlimited, true);
  }
  // forge still bounded
  assert.equal(store.consume('forge').ok, true);
  assert.equal(store.consume('forge').ok, false);
});

// ── A-007: durable — usage survives store restart ───────────────────────
test('A-007 durable: usage survives BudgetStore restart (reload same file)', () => {
  const f = tmpfile('a007.json');
  const s1 = new BudgetStore({ file: f });
  s1.setLimit('forge', { maxActionsPerDay: 10 });
  s1.consume('forge');
  s1.consume('forge');
  s1.consume('forge');
  assert.equal(s1.getUsage('forge').usedToday, 3);

  // restart: new instance, same file
  const s2 = new BudgetStore({ file: f });
  assert.equal(s2.getUsage('forge').usedToday, 3, 'usedToday must survive restart');
  assert.equal(s2.getLimit('forge').maxActionsPerDay, 10);
});

// ── A-008: POSIX-only file mode 0600 ────────────────────────────────────
test('A-008 file mode 0600 (POSIX only; Windows ignores POSIX mode bits)', () => {
  if (process.platform === 'win32') {
    // Skip on Windows — chmodSync is a best-effort no-op there. The default
    // ACL on NTFS is already stricter than 0600 for the creating user.
    return;
  }
  const f = tmpfile('a008.json');
  const s = new BudgetStore({ file: f });
  s.setLimit('forge', { maxActionsPerDay: 5 });
  const mode = fs.statSync(f).mode & 0o777;
  assert.equal(mode, 0o600);
});