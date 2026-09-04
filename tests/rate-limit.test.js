'use strict';
// Tests for the slice: perimeter-guards — rate-limit + audit since-cap.
// Acceptance: A-001..A-006 + invalid_limit guards (A-004).
//
// A-001 27th request within a minute from same token => 429 rate_limited
// A-002 the 429 event is audit-sealed (type:'rate_limited' visible via gw.chain)
// A-003 GET /v1/audit?since=0 on a chain with >500 entries returns <=500 + nextSince
// A-004 limit=abc or limit=0 or limit=9999 => 400 invalid_limit
// A-005 healthz (auth:none) never rate-limited: 100 rapid calls all 200
// A-006 bucket resets: with now() injected, next-window call succeeds

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Gateway, parseLimit, hashToken } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');

// ── harness ───────────────────────────────────────────────────────────────

function makeReqRes({ method = 'GET', url = '/', token = null, body = null, contentType = 'application/json' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers.authorization = 'Bearer ' + token;
  if (body !== null && body !== undefined) req.headers['content-type'] = contentType;
  req.on = EventEmitter.prototype.on;
  let statusCode = null;
  let bodyStr = '';
  let headers = {};
  const res = {
    writeHead(s, h) { statusCode = s; headers = h || {}; },
    end(b) { bodyStr = typeof b === 'string' ? b : (b == null ? '' : String(b)); },
    once() {}, // SSE mounts call .once; no-op here
    on() {},   // SSE mounts call .on; no-op here
  };
  if (body !== null && body !== undefined) {
    process.nextTick(() => { req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end'); });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  return {
    req, res,
    getStatus: () => statusCode,
    getBody: () => { try { return JSON.parse(bodyStr); } catch { return bodyStr; } },
    getHeaders: () => headers,
  };
}

function makeGateway(opts = {}) {
  return new Gateway(Object.assign({
    bots: {
      forge: { tokenHash: hashToken('tok-forge'), role: 'worker', capabilities: ['fs.write:*', 'fs.read'] },
      atlas: { tokenHash: hashToken('tok-atlas'), role: 'operator', capabilities: [] },
    },
    dispatch: async (bot, tool) => ({ ok: true, tool }),
  }, opts));
}

// Drive `n` sequential v1 actions through the gateway; returns array of
// { status, body }. Uses a fresh in-process gateway (and a fixed clock
// via opts.now) so the bucket is deterministic.
async function fireActions(gw, n, token, tool = 'fs.read:notes/x.md') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { req, res, getStatus, getBody } = makeReqRes({
      method: 'POST', url: '/v1/actions', token,
      body: { tool, args: { i } },
    });
    await gw.handle(req, res);
    out.push({ status: getStatus(), body: getBody() });
  }
  return out;
}

// ── A-001: 27th request within a minute from same token => 429 ────────────

test('A-001: 27th request in same window from one token => 429 rate_limited', async () => {
  // Default budget = 60/min, so 60 allowed and 61..N => 429.
  // Drive 61 calls so request #61 is the first 429.
  let now = 1_000_000;
  const gw = makeGateway({ now: () => now });
  const results = await fireActions(gw, 61, 'tok-forge');
  assert.equal(results[59].status, 200, '60th call should still pass');
  assert.equal(results[60].status, 429, '61st call should be 429');
  assert.equal(results[60].body.error, 'rate_limited');
});

// ── A-002: the 429 event is audit-sealed ──────────────────────────────────

test('A-002: the 429 event is audit-sealed (type:rate_limited visible via gw.chain)', async () => {
  let now = 1_000_000;
  const gw = makeGateway({ now: () => now });
  await fireActions(gw, 61, 'tok-forge');
  // Walk the chain (skipping genesis) and find the rate_limited entry.
  const sealed = gw.chain.since(0).entries.find((e) => e.payload.type === 'rate_limited');
  assert.ok(sealed, 'expected a rate_limited audit entry');
  assert.equal(sealed.payload.bot, 'forge');
  assert.equal(typeof sealed.hash, 'string');
  assert.equal(sealed.hash.length, 64);
  // verify() must still pass — write-ahead invariant.
  const v = gw.chain.verify();
  assert.equal(v.ok, true);
});

// ── A-003: GET /v1/audit?since=0 on a chain with >500 entries returns ≤500 + nextSince ──

test('A-003: GET /v1/audit?since=0 caps at limit and returns nextSince cursor', async () => {
  const gw = makeGateway();
  // Seed >500 entries (default budget caps chain reads, not chain writes —
  // rate-limit is per-minute, not per-chain-length).
  for (let i = 0; i < 600; i++) gw._audit({ type: 'filler', i });
  const { req, res, getStatus, getBody } = makeReqRes({
    method: 'GET', url: '/v1/audit?since=0', token: 'tok-forge',
  });
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  const body = getBody();
  assert.ok(Array.isArray(body.entries), 'entries must be an array');
  assert.ok(body.entries.length <= 500, 'page must be capped at default limit=500');
  assert.equal(typeof body.nextSince, 'number', 'nextSince cursor required');
  assert.ok(body.nextSince >= body.entries[0].seq, 'nextSince >= first entry seq');
  assert.ok(body.entries[body.entries.length - 1].seq <= body.nextSince, 'nextSince >= last entry seq');
  // Page forward and confirm we get the rest of the chain.
  const { req: req2, res: res2, getStatus: s2, getBody: b2 } = makeReqRes({
    method: 'GET', url: `/v1/audit?since=${body.nextSince}`, token: 'tok-forge',
  });
  await gw.handle(req2, res2);
  assert.equal(s2(), 200);
  const page2 = b2();
  assert.ok(page2.entries.length > 0, 'second page should have entries');
  assert.ok(page2.nextSince === null || typeof page2.nextSince === 'number');
});

// ── A-004: invalid limit => 400 invalid_limit ─────────────────────────────

test('A-004: invalid limit values => 400 invalid_limit (fail closed)', async () => {
  const gw = makeGateway();
  // Populate enough entries that a valid call would actually return rows.
  for (let i = 0; i < 5; i++) gw._audit({ type: 'filler', i });
  for (const bad of ['abc', '0', '9999', '-1', '1.5']) {
    const { req, res, getStatus, getBody } = makeReqRes({
      method: 'GET', url: `/v1/audit?limit=${encodeURIComponent(bad)}`, token: 'tok-forge',
    });
    await gw.handle(req, res);
    assert.equal(getStatus(), 400, `limit=${bad} should 400`);
    assert.equal(getBody().error, 'invalid_limit');
  }
  // Empty / missing limit is allowed (defaults to 500).
  const { req: req2, res: res2, getStatus: s2, getBody: b2 } = makeReqRes({
    method: 'GET', url: '/v1/audit', token: 'tok-forge',
  });
  await gw.handle(req2, res2);
  assert.equal(s2(), 200);
  assert.ok(Array.isArray(b2().entries));
});

test('parseLimit unit cases', () => {
  assert.equal(parseLimit(null), 500);
  assert.equal(parseLimit(undefined), 500);
  assert.equal(parseLimit(''), 500);
  assert.equal(parseLimit('50'), 50);
  assert.equal(parseLimit('5000'), 5000);
  assert.equal(parseLimit('abc'), null);
  assert.equal(parseLimit('0'), null);
  assert.equal(parseLimit('-5'), null);
  assert.equal(parseLimit('1.5'), null);
  assert.equal(parseLimit('5001'), null);
});

// ── A-005: healthz (auth:none) never rate-limited ────────────────────────

test('A-005: 100 rapid healthz calls all 200 (auth:none, never rate-limited)', async () => {
  const gw = makeGateway();
  for (let i = 0; i < 100; i++) {
    const { req, res, getStatus, getBody } = makeReqRes({
      method: 'GET', url: '/healthz', token: null,
    });
    await gw.handle(req, res);
    assert.equal(getStatus(), 200, `healthz call #${i + 1} should be 200`);
    assert.equal(getBody().ok, true);
  }
  // And critically: no rate_limited entries on the chain — healthz must
  // not even increment counters.
  const sealed = gw.chain.since(0).entries.filter((e) => e.payload.type === 'rate_limited');
  assert.equal(sealed.length, 0, 'healthz must not audit rate-limit hits');
});

// ── A-006: bucket resets: next-window call succeeds ──────────────────────

test('A-006: bucket resets in the next window — injected now() advances past 60s', async () => {
  let now = 1_000_000;
  const gw = makeGateway({ now: () => now });
  // Burn the budget: 60 calls all 200.
  const first = await fireActions(gw, 60, 'tok-forge');
  assert.equal(first[59].status, 200);
  // 61st call in the SAME window: 429.
  const over = await fireActions(gw, 1, 'tok-forge');
  assert.equal(over[0].status, 429);
  assert.equal(over[0].body.error, 'rate_limited');
  // Advance the injected clock past the 60s window.
  now += 60_001;
  const after = await fireActions(gw, 1, 'tok-forge');
  assert.equal(after[0].status, 200, 'first call in next window must succeed');
});

// ── operator multiplier (3x by default) ──────────────────────────────────

test('operator bot gets 3x budget: 181st request in window => 429', async () => {
  let now = 1_000_000;
  const gw = makeGateway({ now: () => now });
  // Default operator mult = 3, base = 60 → effective budget 180.
  const results = await fireActions(gw, 181, 'tok-atlas', 'fs.read:notes/x.md');
  assert.equal(results[179].status, 200, '180th call should pass (within 3x budget)');
  assert.equal(results[180].status, 429, '181st call should be 429');
});

// ── env-driven configuration ────────────────────────────────────────────

test('env TG_RATE_LIMIT overrides the default; non-positive values are ignored', () => {
  const prev = process.env.TG_RATE_LIMIT;
  process.env.TG_RATE_LIMIT = '5';
  try {
    const gw = makeGateway();
    assert.equal(gw.rateLimit, 5);
  } finally {
    if (prev === undefined) delete process.env.TG_RATE_LIMIT;
    else process.env.TG_RATE_LIMIT = prev;
  }
  // Non-positive / NaN falls back to default.
  const prev2 = process.env.TG_RATE_LIMIT;
  process.env.TG_RATE_LIMIT = 'not-a-number';
  try {
    const gw = makeGateway();
    assert.equal(gw.rateLimit, 60);
  } finally {
    if (prev2 === undefined) delete process.env.TG_RATE_LIMIT;
    else process.env.TG_RATE_LIMIT = prev2;
  }
});

// ── /v2/rate-limit mount: never exposes tokens ──────────────────────────

test('GET /v2/rate-limit returns config + caller remaining; never token values', async () => {
  const gw = makeGateway();
  // No requests yet: remaining is null (no bucket touched this window).
  const { req, res, getStatus, getBody } = makeReqRes({
    method: 'GET', url: '/v2/rate-limit', token: 'tok-forge',
  });
  await gw.handle(req, res);
  assert.equal(getStatus(), 200);
  const body = getBody();
  assert.equal(body.config.base, 60);
  assert.equal(body.config.operatorMultiplier, 3);
  assert.equal(body.config.windowMs, 60_000);
  assert.equal(body.you.role, 'worker');
  assert.equal(body.you.budget, 60);
  // After only the rate-limit endpoint itself, one slot is consumed.
  assert.equal(body.you.remaining, 59);
  // Strict: response must not contain any token string.
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes('tok-forge'), 'must not leak caller token');
  assert.ok(!blob.includes('tok-atlas'), 'must not leak any token');
});

test('GET /v2/rate-limit unauthenticated => 401', async () => {
  const gw = makeGateway();
  const { req, res, getStatus } = makeReqRes({
    method: 'GET', url: '/v2/rate-limit', token: null,
  });
  await gw.handle(req, res);
  assert.equal(getStatus(), 401);
});

// ── v2 mount route is also rate-limited (bearer auth path) ──────────────

test('v2 bearer mounts share the rate-limit guard: 61st /v2/rate-limit call => 429', async () => {
  let now = 1_000_000;
  const gw = makeGateway({ now: () => now });
  // 60 OK + 1 429
  let last429 = null;
  for (let i = 0; i < 61; i++) {
    const { req, res, getStatus, getBody } = makeReqRes({
      method: 'GET', url: '/v2/rate-limit', token: 'tok-forge',
    });
    await gw.handle(req, res);
    if (getStatus() === 429) last429 = getBody();
  }
  assert.ok(last429, 'expected a 429 in the burst');
  assert.equal(last429.error, 'rate_limited');
});

// ── since() on SqlChain honours the same contract ───────────────────────

test('HashChain.since and SqlChain.since share the {entries, nextSince} surface', async () => {
  const { SqlChain } = require('../src/gateway/sql-chain');
  const h = new SqlChain({ file: require('node:os').tmpdir() + '/tg-rl-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db' });
  try {
    for (let i = 0; i < 7; i++) h.append({ i });
    const page = h.since(0, { limit: 3 });
    assert.equal(page.entries.length, 3);
    assert.equal(page.nextSince, 3);
    const next = h.since(page.nextSince);
    assert.equal(next.entries.length, 4);
    assert.equal(next.nextSince, null);
  } finally {
    try { require('node:fs').rmSync(require('node:path').dirname(h.file), { recursive: true, force: true }); } catch { /* best effort */ }
    h.close();
  }
});