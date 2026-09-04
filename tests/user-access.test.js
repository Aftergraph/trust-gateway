'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// FS-A2 tests: identity-aware API + user-bound chat.
//
// Covers:
//   - user-access.js: botGrants shape [{bot, role}] helpers (grant/revoke/canUse),
//     verbatim persistence contract, identity projection (strict: no secret material)
//   - mounts/102-identity.js: GET /v2/me — user projection, 401 anonymous,
//     bearer fallback = /v2/whoami shape
//   - mounts/103-chat-user.js: POST /v2/chat/llm/user — grant enforcement (403),
//     session namespacing u_<userId>:<session> (visible in /h via planner),
//     30/min sliding window (429 + Retry-After), bearer path unchanged
//     (delegates to the same mount handler /v2/chat/llm uses).
// Existing chat tests (tests/chat.test.js, tests/llm-brain.test.js) are NOT
// modified — bearer regression freedom is asserted by the suite staying green
// plus the explicit bearer-fallback parity checks here.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const {
  normalizeGrants, grant, revoke, canUse, firstGrantedBot,
  capabilitiesForGrants, projectUser, DEFAULT_ROLE,
} = require('../src/gateway/user-access');
const { LlmBrain, setBrain } = require('../src/gateway/llm-brain');
const { getPlanner } = require('../src/gateway/chat-singleton');

// ── helpers ──────────────────────────────────────────────────────

function makeGw() {
  return new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*', 'mail.send'] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

// OpenAI-shaped mock upstream (same rule-8 pattern as llm-brain.test.js).
function startStub(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, body: parsed });
      handler(req, res, parsed);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      seen,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}
const completion = (content) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

const get = (base, path, token) =>
  fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const post = (base, path, body, token) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// Session user fixture — exactly the shape gw._currentUser(req) must return.
function userFixture(id, grants) {
  return {
    id,
    role: 'user',
    name: `User ${id}`,
    email: `${id}@example.test`,
    passwordHash: 'sha256$NEVER-LEAK-ME',
    botGrants: grants,
  };
}

const auditTypes = (gw) => gw.chain.entries.map((e) => e.payload.type);
const auditPayloads = (gw, type) => gw.chain.entries.filter((e) => e.payload.type === type).map((e) => e.payload);

// ── unit: botGrants shape helpers ────────────────────────────────

test('grants: grant() produces the canonical [{bot, role}] shape with worker default', () => {
  const g = grant([], 'forge');
  assert.deepEqual(g, [{ bot: 'forge', role: DEFAULT_ROLE }]);
  assert.equal(g[0].role, 'worker');
  const g2 = grant(g, 'atlas', 'operator');
  assert.deepEqual(g2, [{ bot: 'forge', role: 'worker' }, { bot: 'atlas', role: 'operator' }]);
});

test('grants: normalizeGrants drops malformed entries, dedupes by bot (last wins)', () => {
  assert.deepEqual(normalizeGrants(null), []);
  assert.deepEqual(normalizeGrants('junk'), []);
  assert.deepEqual(normalizeGrants([null, 42, { bot: '' }, { role: 'x' }, { bot: 'forge' }]),
    [{ bot: 'forge', role: 'worker' }]);
  const out = normalizeGrants([{ bot: 'a', role: 'worker' }, { bot: 'a', role: 'operator' }, { bot: 'a' }]);
  assert.deepEqual(out, [{ bot: 'a', role: 'worker' }]);
});

test('grants: revoke() removes the entry, is pure, and revoking unknown is a no-op', () => {
  const g = grant([], 'forge');
  const g2 = grant(g, 'atlas');
  const g3 = revoke(g2, 'forge');
  assert.deepEqual(g3, [{ bot: 'atlas', role: 'worker' }]);
  assert.deepEqual(g2, [{ bot: 'forge', role: 'worker' }, { bot: 'atlas', role: 'worker' }], 'input untouched');
  assert.deepEqual(revoke(g2, 'nope'), g2.map((x) => ({ ...x })), 'unknown bot → same content');
  assert.throws(() => revoke(g2, 7), TypeError);
});

test('grants: grant() is pure and throws on junk bot/role (nothing silently persisted)', () => {
  const g = grant([], 'forge');
  const g2 = grant(g, 'forge', 'operator');
  assert.deepEqual(g, [{ bot: 'forge', role: 'worker' }], 'input untouched');
  assert.deepEqual(g2, [{ bot: 'forge', role: 'operator' }]);
  assert.throws(() => grant(g, ''), TypeError);
  assert.throws(() => grant(g, null), TypeError);
  assert.throws(() => grant(g, 'forge', ''), TypeError);
});

test('grants: canUse is exact-bot-name and safe on malformed input', () => {
  const user = { id: 'u1', botGrants: [{ bot: 'forge', role: 'worker' }] };
  assert.equal(canUse(user, 'forge'), true);
  assert.equal(canUse(user, 'atlas'), false);
  assert.equal(canUse(user, 'FORGE'), false, 'case-sensitive exact match');
  assert.equal(canUse(null, 'forge'), false);
  assert.equal(canUse({}, 'forge'), false);
  assert.equal(canUse({ botGrants: 'junk' }, 'forge'), false);
  assert.equal(canUse(user, null), false);
  assert.equal(firstGrantedBot(user), 'forge');
  assert.equal(firstGrantedBot({ id: 'u1', botGrants: [] }), null);
  assert.equal(firstGrantedBot(null), null);
});

test('capabilities: union of granted bots\u2019 configured capabilities, unknown bots contribute nothing', () => {
  const gw = makeGw();
  const grants = [{ bot: 'forge' }, { bot: 'atlas', role: 'operator' }];
  const caps = capabilitiesForGrants(grants, gw);
  assert.deepEqual(caps, ['fs.read', 'fs.write:*', '*', 'mail.send'], 'union in grant order');
  assert.deepEqual(capabilitiesForGrants([{ bot: 'ghost' }], gw), [], 'no invented capabilities');
  assert.deepEqual(capabilitiesForGrants([], gw), []);
});

// ── identity projection (projectUser + GET /v2/me) ───────────────

test('projectUser: user fields minus password material, botGrants verbatim, implied capabilities', () => {
  const gw = makeGw();
  const user = {
    id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user',
    passwordHash: 'sha256$TOPSECRET', resetToken: 'tok-xyz', createdAt: 123,
    botGrants: [{ bot: 'forge', role: 'worker' }],
  };
  const p = projectUser(user, gw);
  assert.equal(p.id, 'u1');
  assert.equal(p.name, 'Ada');
  assert.equal(p.email, 'ada@example.test');
  assert.equal(p.createdAt, 123);
  assert.equal(p.passwordHash, undefined, 'password hash never projected');
  assert.equal(p.resetToken, undefined, 'token material never projected');
  assert.deepEqual(p.botGrants, [{ bot: 'forge', role: 'worker' }], 'grants carried verbatim');
  assert.deepEqual(p.capabilities, ['fs.read', 'fs.write:*'], 'capabilities implied by grants');
  assert.ok(!JSON.stringify(p).includes('TOPSECRET-NEVER'), 'no secret string in projection');
});

test('/v2/me: logged-in user gets strict identity projection; audit carries userId ONLY', async () => {
  const gw = makeGw();
  gw._currentUser = () => ({
    id: 'u1', name: 'Ada', email: 'ada@example.test',
    passwordHash: 'sha256$LEAK-CANARY', botGrants: [{ bot: 'forge', role: 'worker' }],
  });
  const srv = await startGateway(gw);
  try {
    const res = await get(srv.base, '/v2/me');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'u1');
    assert.equal(body.email, 'ada@example.test');
    assert.equal(body.passwordHash, undefined);
    assert.ok(!JSON.stringify(body).includes('LEAK-CANARY'));
    assert.deepEqual(body.botGrants, [{ bot: 'forge', role: 'worker' }]);
    assert.deepEqual(body.capabilities, ['fs.read', 'fs.write:*']);
    const rows = auditPayloads(gw, 'identity_me');
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).filter((k) => k !== 'type'), ['userId'], 'userId only');
    assert.equal(rows[0].userId, 'u1');
  } finally { await srv.close(); }
});

test('/v2/me: 401 when anonymous (no hook, no bearer)', async () => {
  const gw = makeGw();
  const srv = await startGateway(gw);
  try {
    const res = await get(srv.base, '/v2/me');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally { await srv.close(); }
});

test('/v2/me: bearer fallback projects the bot identity like /v2/whoami (regression-free)', async () => {
  const gw = makeGw(); // no _currentUser hook at all
  const srv = await startGateway(gw);
  try {
    const me = await (await get(srv.base, '/v2/me', 'tok-forge')).json();
    const who = await (await get(srv.base, '/v2/whoami', 'tok-forge')).json();
    // FS-E1 slice 3: /v2/me gains ONE added field (tenant) — parity with
    // /v2/whoami modulo that field, byte-identical for the default tenant.
    assert.deepEqual(me, Object.assign({}, who, { tenant: 'main' }));
    assert.equal(me.tenant, 'main');
    assert.equal(me.name, 'forge');
    assert.deepEqual(me.capabilities, ['fs.read', 'fs.write:*']);
    assert.equal(me.botGrants, undefined, 'bearer path exposes no user concept');
  } finally { await srv.close(); }
});

// ── /v2/chat/llm/user: grant enforcement (403) ───────────────────

test('chat user: 403 bot_not_granted when the acting bot is not granted (explicit or default)', async () => {
  const gw = makeGw();
  gw._currentUser = () => ({ id: 'u1', botGrants: [{ bot: 'forge', role: 'worker' }] });
  const srv = await startGateway(gw);
  try {
    // explicit ungranted bot
    let res = await post(srv.base, '/v2/chat/llm/user', { session: 's1', message: 'hi', bot: 'atlas' });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'bot_not_granted', bot: 'atlas' });
    // no grants at all → default resolution fails → 403
    gw._currentUser = () => ({ id: 'u2', botGrants: [] });
    res = await post(srv.base, '/v2/chat/llm/user', { session: 's1', message: 'hi' });
    assert.equal(res.status, 403);
    // denial audited {userId, bot}, no brain call audited
    const denied = auditPayloads(gw, 'chat_user_denied');
    assert.equal(denied.length, 2);
    assert.equal(denied[0].userId, 'u1');
    assert.equal(denied[0].bot, 'atlas');
    assert.equal(denied[1].userId, 'u2');
  } finally { await srv.close(); }
});

test('chat user: granted user turn runs the same governed brain; session namespaced u_<userId>:<session>', async () => {
  const stub = await startStub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion('plain reply, no actions')); });
  const gw = makeGw();
  setBrain(gw, new LlmBrain({ gateway: gw, baseUrl: stub.url, apiKey: 'k-test', model: 'test-model', timeoutMs: 500 }));
  gw._currentUser = () => ({ id: 'u1', botGrants: [{ bot: 'forge', role: 'worker' }] });
  const srv = await startGateway(gw);
  try {
    const res = await post(srv.base, '/v2/chat/llm/user', { session: 'work', message: 'hello' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, 'plain reply, no actions');
    // namespaced planner session → shows up as its own session in /h
    const names = getPlanner(gw).listSessions().map((s) => s.name);
    assert.ok(names.includes('u_u1:work'), `expected namespaced session, got ${JSON.stringify(names)}`);
    assert.ok(!names.includes('work'), 'bare session name must NOT be created');
    // ok audited with the namespaced session name only
    const ok = auditPayloads(gw, 'chat_user_ok');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].userId, 'u1');
    assert.equal(ok[0].session, 'u_u1:work');
    // the governed brain actually ran against the mock upstream
    assert.equal(stub.seen.length, 1);
    assert.equal(stub.seen[0].url, '/v1/chat/completions');
  } finally { await srv.close(); await stub.close(); }
});

test('chat user: /h index lists user-bound sessions under their namespaced names', async () => {
  const stub = await startStub((req, res) => { res.end(completion('ok')); });
  const gw = makeGw();
  setBrain(gw, new LlmBrain({ gateway: gw, baseUrl: stub.url, apiKey: 'k-test', model: 'test-model', timeoutMs: 500 }));
  gw._currentUser = () => ({ id: 'u1', botGrants: [{ bot: 'forge', role: 'worker' }] });
  const srv = await startGateway(gw);
  try {
    await post(srv.base, '/v2/chat/llm/user', { session: 'proj', message: 'hi' });
    const idx = await get(srv.base, '/h', 'tok-atlas'); // operator-only index
    assert.equal(idx.status, 200);
    const html = await idx.text();
    assert.ok(html.includes('u_u1:proj'), 'user-bound session visible in /h');
    // history rows for the namespaced session are reachable via the planner
    const s = getPlanner(gw).sessions.get('u_u1:proj');
    assert.ok(s && s.history.length >= 2, 'namespaced session holds the turn history');
  } finally { await srv.close(); await stub.close(); }
});

// ── /v2/chat/llm/user: per-user sliding-window rate limit ────────

test('chat user: 30/min sliding window per user → 429 with Retry-After; other users unaffected', async () => {
  const gw = makeGw(); // unconfigured brain → propose falls back fast, no upstream
  gw._currentUser = () => ({ id: 'u1', botGrants: [{ bot: 'forge', role: 'worker' }] });
  const srv = await startGateway(gw);
  try {
    let last;
    for (let i = 0; i < 30; i++) {
      last = await post(srv.base, '/v2/chat/llm/user', { session: 'burst', message: `m${i}` });
      assert.equal(last.status, 200, `request ${i + 1} must pass`);
    }
    const res31 = await post(srv.base, '/v2/chat/llm/user', { session: 'burst', message: 'over' });
    assert.equal(res31.status, 429);
    assert.ok(Number(res31.headers.get('retry-after')) >= 1, 'Retry-After header present');
    assert.equal((await res31.json()).error, 'rate_limited');
    // a different user has her own bucket
    gw._currentUser = () => ({ id: 'u2', botGrants: [{ bot: 'forge', role: 'worker' }] });
    const other = await post(srv.base, '/v2/chat/llm/user', { session: 'burst', message: 'mine' });
    assert.equal(other.status, 200, 'second user unaffected by u1\u2019s limit');
  } finally { await srv.close(); }
});

// ── bearer fallback: behavior unchanged by construction ──────────

test('chat user: bearer path (no _currentUser) delegates to /v2/chat/llm verbatim — same reply, un-namespaced session', async () => {
  const stub = await startStub((req, res) => { res.end(completion('bearer reply')); });
  const make = () => {
    const gw = makeGw();
    setBrain(gw, new LlmBrain({ gateway: gw, baseUrl: stub.url, apiKey: 'k-test', model: 'test-model', timeoutMs: 500 }));
    return gw;
  };
  const gwUser = make();
  const gwPlain = make();
  const srvU = await startGateway(gwUser);
  const srvP = await startGateway(gwPlain);
  try {
    // the user-gated route, bearer fallback
    const a = await post(srvU.base, '/v2/chat/llm/user', { session: 'plain', message: 'hi', bot: 'forge' }, 'tok-forge');
    assert.equal(a.status, 200);
    // the original route
    const b = await post(srvP.base, '/v2/chat/llm', { session: 'plain', message: 'hi', bot: 'forge' }, 'tok-forge');
    assert.equal(b.status, 200);
    const ja = await a.json();
    const jb = await b.json();
    assert.deepEqual(ja, jb, 'byte-equal behavior with POST /v2/chat/llm');
    assert.ok(!getPlanner(gwUser).listSessions().some((s) => s.name.startsWith('u_')), 'no namespacing on bearer path');
    // no bearer, no user → 401
    const anon = await post(srvU.base, '/v2/chat/llm/user', { session: 's', message: 'hi' });
    assert.equal(anon.status, 401);
  } finally {
    await srvU.close(); await srvP.close(); await stub.close();
  }
});

test('chat user: validation and audit hygiene — no message text, no secret material in the chain', async () => {
  const gw = makeGw();
  gw._currentUser = () => ({ id: 'u1', email: 'a@b.c', passwordHash: 'x', botGrants: [] });
  const srv = await startGateway(gw);
  try {
    assert.equal((await post(srv.base, '/v2/chat/llm/user', { message: 'hi' })).status, 400, 'session_required');
    assert.equal((await post(srv.base, '/v2/chat/llm/user', { session: 's' })).status, 400, 'message_required');
    assert.equal((await post(srv.base, '/v2/chat/llm/user', { session: 's', message: 'hi' })).status, 403, 'no grants');
    const dump = JSON.stringify(gw.chain.entries);
    assert.ok(!dump.includes('a@b.c'), 'no email in the audit chain');
    assert.ok(!dump.includes('hi'), 'no message text in the audit chain');
    assert.equal(gw.chain.verify().ok, true, 'chain still sealed');
  } finally { await srv.close(); }
});