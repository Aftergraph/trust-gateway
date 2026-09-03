'use strict';
// FS-F2 conformance tier-B — RATE LIMITS deep battery.
//
// FS-A2 (human auth) + FS-E3 (external API keys), on REAL spawned gateways:
//   • /v2/auth/register → 5/min/IP; the 6th is refused 429 — and a SECOND
//     loopback address (127.0.0.2) is unaffected: the limiter is per-IP.
//   • /v2/auth/login → 10/min/IP; the 11th attempt is refused 429.
//   • /v2/apikeys with a rate window: exceed → verify() refuses inside the
//     window, a NEW window admits again, and the counter PERSISTS across a
//     real spawned-gateway restart on the SAME TG_DB_FILE (SQLite
//     rate_hits, atomic tx — the FS-E3 R5 guarantee).
//
// Zero deps beyond node: builtins. Spawns its own gateways. The SQLite
// registry (TG_DB_FILE) is created here and shared with the spawned child —
// the read-mount acceptance path (store.verify()) is the same resolution
// path the scoped read mounts use.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnGateway, TOKENS } = require('../../fs-helpers');

const TESTS = [];
function t(name, fn) { TESTS.push({ name, fn }); }

// SQLite registry bound to THIS dir for the whole battery (set before the
// first spawn / first require of db.js).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsf2-rl-'));
process.env.TG_DB_FILE = path.join(DIR, 'gateway.db');
// human-auth stores land in this jail too — never the repo data dir
process.env.TG_USERS_FILE = path.join(DIR, 'users.json');
process.env.TG_SESSIONS_FILE = path.join(DIR, 'sessions.json');

let gw = null;
let emailBase = '';
let key1 = null; // persistent-counter key  {windowMs: 10min, max: 2}
let key2 = null; // window-reset key        {windowMs: 1s, max: 1}

// ── tiny HTTP client (supports localAddress for per-IP tests) ────────────
const AUTH = 'Bear' + 'er ';
function req(port, method, p, { body, token, localAddress, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1',
      port,
      localAddress, // undefined → default loopback source
      method,
      path: p,
      headers: Object.assign(
        token ? { authorization: AUTH + token } : {},
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        headers || {},
      ),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function freshStore() {
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/apikeys.js')) delete require.cache[m];
  }
  return require('../../../src/gateway/apikeys');
}

const EMAIL = (n) => `fsf2-rl-${Date.now()}-${n}@tierb.test`;
const PASSWORD = 'tierb-password-9x';

// ── FS-A2: user rate limits ──────────────────────────────────────────────

t('FS-A2 register: exactly 5/min per IP — 6th refused 429', async (ctx) => {
  const { port } = ctx;
  for (let i = 0; i < 5; i++) {
    const r = await req(port, 'POST', '/v2/auth/register', { body: { email: EMAIL(i), password: PASSWORD } });
    assert.equal(r.status, 201, `register #${i + 1} → 201, got ${r.status} ${JSON.stringify(r.json)}`);
  }
  const sixth = await req(port, 'POST', '/v2/auth/register', { body: { email: EMAIL(99), password: PASSWORD } });
  assert.equal(sixth.status, 429, '6th register inside the window is refused');
  assert.equal(sixth.json.error, 'rate_limited');
});

t('FS-A2 limiter is per-IP: a second loopback address is NOT limited', async (ctx) => {
  const { port } = ctx;
  const r = await req(port, 'POST', '/v2/auth/register',
    { body: { email: EMAIL('alt'), password: PASSWORD }, localAddress: '127.0.0.2' });
  assert.equal(r.status, 201, `register from 127.0.0.2 → 201 (per-IP window), got ${r.status} ${JSON.stringify(r.json)}`);
});

t('FS-A2 login: exactly 10/min per IP — 11th refused 429', async (ctx) => {
  const { port } = ctx;
  for (let i = 0; i < 10; i++) {
    const r = await req(port, 'POST', '/v2/auth/login', { body: { email: EMAIL(0), password: 'wrong-password-aa' } });
    assert.equal(r.status, 401, `bad login #${i + 1} → generic 401, got ${r.status}`);
    assert.equal(r.json.error, 'invalid credentials');
  }
  const eleventh = await req(port, 'POST', '/v2/auth/login', { body: { email: EMAIL(0), password: 'wrong-password-aa' } });
  assert.equal(eleventh.status, 429, '11th login inside the window is refused');
  assert.equal(eleventh.json.error, 'rate_limited');
  // good credentials are ALSO refused while the window holds (fail closed)
  const good = await req(port, 'POST', '/v2/auth/login', { body: { email: EMAIL(0), password: PASSWORD } });
  assert.equal(good.status, 429, 'even a VALID login is refused while rate-limited');
});

// ── FS-E3: external apikey rate windows ──────────────────────────────────

t('FS-E3 create over HTTP: operator-only; plaintext once; rate recorded', async (ctx) => {
  const { base } = ctx;
  const denied = await req(ctx.port, 'POST', '/v2/apikeys', { token: ctx.tokens.forge, body: { name: 'nope', scopes: ['audit.read'] } });
  assert.equal(denied.status, 403, 'worker cannot mint api keys');
  const created = await req(ctx.port, 'POST', '/v2/apikeys', {
    token: ctx.tokens.atlas,
    body: { name: 'tierb-persist', owner: 'atlas', scopes: ['audit.read'], rate: { windowMs: 600000, max: 2 } },
  });
  assert.equal(created.status, 201, `create → 201, got ${created.status} ${JSON.stringify(created.json)}`);
  assert.match(created.json.plaintext, /^tgk_[0-9a-f]{48}$/);
  const listed = await req(ctx.port, 'GET', '/v2/apikeys', { token: ctx.tokens.atlas });
  assert.ok(!JSON.stringify(listed.json).includes(created.json.plaintext.slice(4)), 'list leaks plaintext material');
  key1 = created.json.plaintext;
});

t('FS-E3 exceed: verify refuses inside the window (max 2)', async () => {
  const { ApiKeyStore } = freshStore();
  const store = new ApiKeyStore();
  assert.equal(store.verify(key1).ok, true, 'hit 1 ok');
  assert.equal(store.verify(key1).ok, true, 'hit 2 ok');
  const third = store.verify(key1);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'rate_limited', 'hit 3 refused inside the window');
});

t('FS-E3 window reset: a NEW window admits again (short 1s window)', async () => {
  // short-window key for a fast, bounded reset proof
  const created = await req(gw.port, 'POST', '/v2/apikeys', {
    token: gw.tokens.atlas,
    body: { name: 'tierb-reset', owner: 'atlas', scopes: ['audit.read'], rate: { windowMs: 1000, max: 1 } },
  });
  assert.equal(created.status, 201);
  key2 = created.json.plaintext;
  const { ApiKeyStore } = freshStore();
  const store = new ApiKeyStore();
  assert.equal(store.verify(key2).ok, true, 'hit 1 ok');
  assert.equal(store.verify(key2).reason, 'rate_limited', 'hit 2 refused inside window');
  await new Promise((r) => setTimeout(r, 1100)); // strictly past the 1s window
  assert.equal(store.verify(key2).ok, true, 'window rolled → allowed again');
});

t('FS-E3 PERSISTENCE: counter survives a REAL gateway restart on the same TG_DB_FILE', async (ctx) => {
  await ctx.close();
  const gw2 = await spawnGateway({}); // same process.env.TG_DB_FILE → same SQLite
  ctx.adopt(gw2);
  const { ApiKeyStore } = freshStore();
  const store = new ApiKeyStore();
  const v = store.verify(key1);
  assert.equal(v.reason, 'rate_limited', 'rate counter survived the restart');
  assert.equal(v.ok, false);
  // the key row itself persisted too — and revocation still works after restart
  const revoke = await req(gw2.port, 'POST', `/v2/apikeys/ak_unknown/revoke`, { token: gw2.tokens.atlas, body: {} });
  assert.equal(revoke.status, 404, 'unknown id stays 404 after restart');
  const listed = await req(gw2.port, 'GET', '/v2/apikeys', { token: gw2.tokens.atlas });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.keys.some((k) => k.name === 'tierb-persist'), 'key row persisted across restart');
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  let fails = 0;
  const ctx = {
    port: null, base: null, tokens: TOKENS,
    close: () => gw && gw.close(),
    adopt(g) { gw = g; ctx.port = g.port; ctx.base = g.base; },
  };
  try {
    gw = await spawnGateway({});
    ctx.port = gw.port;
    ctx.base = gw.base;
  } catch (e) {
    console.error('RATELIMITS CRASH', e && e.message);
    process.exit(2);
  }
  if (gw) {
    for (const { name, fn } of TESTS) {
      try { await fn(ctx); console.log('  ✔ ' + name); }
      catch (e) { fails++; console.log('  ✖ ' + name + '\n      → ' + (e && e.message)); }
    }
    await ctx.close();
  }
  console.log(fails ? '\n✖ RATELIMITS ' + fails + ' failed' : '\n★ RATELIMITS PASS');
  process.exit(fails ? 1 : 0);
})();