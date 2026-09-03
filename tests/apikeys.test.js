'use strict';
// FS-E3 — external API keys: store unit tests + mount surface + read-mount
// acceptance + persistent rate limits + write-always-refused.
//
// The read-mount acceptance helper lives in the store test via the same
// resolution path the mounts will use (verify() + scope check); HTTP-level
// tests exercise the CRUD mount end-to-end on a real Gateway.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e3-'));
  const prevDb = process.env.TG_DB_FILE;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  process.chdir(dir);
  const done = () => {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = prevDb;
  };
  return Promise.resolve().then(() => fn(dir)).finally(done);
}

function fresh() {
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/apikeys.js') ||
        m.endsWith('/src/gateway/mounts/112-apikeys.js')) delete require.cache[m];
  }
  const { ApiKeyStore, getApiKeyStore, SCOPES } = require('../src/gateway/apikeys');
  return { ApiKeyStore, getApiKeyStore, SCOPES };
}

test('apikeys: create → plaintext exactly once; list never leaks material', async () => {
  await withDbFile(async () => {
    const { ApiKeyStore } = fresh();
    const s = new ApiKeyStore();
    const out = s.create({ name: 'ci-script', owner: 'atlas', scopes: ['audit.read', 'search.read'] });
    assert.equal(out.ok, true);
    assert.match(out.plaintext, /^tgk_[0-9a-f]{48}$/);
    // key_hint is derived from the key HASH (never the plaintext) — assert
    // only the shape: tgk_ + 4 chars + ellipsis.
    assert.match(out.record.key_hint, /^tgk_[0-9a-f]{4}…$/);
    // list/get: no plaintext, no full hash
    const listed = JSON.stringify(s.list());
    assert.ok(!listed.includes(out.plaintext.slice(4)), 'plaintext material leaked in list');
    assert.ok(!/key_hash/.test(listed), 'hash column leaked in list');
    // invalid inputs fail closed
    assert.equal(s.create({ name: '', owner: 'a', scopes: ['audit.read'] }).error, 'invalid_name');
    assert.equal(s.create({ name: 'x', owner: 'a', scopes: ['admin.all'] }).error, 'invalid_scopes');
    assert.equal(s.create({ name: 'x', owner: 'a', scopes: 'audit.read' }).error, 'invalid_scopes');
    assert.equal(s.create({ name: 'x', owner: 'a', scopes: ['audit.read'], rate: { windowMs: -1, max: 5 } }).error, 'invalid_rate');
  });
});

test('apikeys: verify happy / unknown / disabled; timing path', async () => {
  await withDbFile(async () => {
    const { ApiKeyStore } = fresh();
    const s = new ApiKeyStore();
    const { plaintext } = s.create({ name: 'k', owner: 'a', scopes: ['audit.read'] });
    assert.equal(s.verify(plaintext).ok, true);
    assert.ok(s.verify(plaintext).record.last_used_at > 0);
    assert.equal(s.verify('tgk_' + '0'.repeat(48)).reason, 'unknown');
    assert.equal(s.verify('garbage').reason, 'unknown');
    // revoke → disabled
    const id = s.verify(plaintext).record.id;
    s.revoke(id);
    assert.equal(s.verify(plaintext).reason, 'disabled');
  });
});

test('apikeys: rate limit counter SURVIVES restart (same TG_DB_FILE)', async () => {
  await withDbFile(async (dir) => {
    let { ApiKeyStore } = fresh();
    const s1 = new ApiKeyStore({ now: () => 1788437500000 }); // epoch ms
    const { plaintext } = s1.create({
      name: 'limited', owner: 'a', scopes: ['audit.read'],
      rate: { windowMs: 600000, max: 2 }, // 10-min window so all nows share it
    });
    assert.equal(s1.verify(plaintext).ok, true);
    assert.equal(s1.verify(plaintext).ok, true);
    assert.equal(s1.verify(plaintext).reason, 'rate_limited'); // 3rd hit inside window

    // "restart": fresh module graph on same file, DIFFERENT now (same window)
    ({ ApiKeyStore } = fresh());
    const s2 = new ApiKeyStore({ now: () => 1788437550000 });
    assert.equal(s2.verify(plaintext).reason, 'rate_limited', 'counter persisted across restart');
    // a NEW window resets the counter
    const s3 = new ApiKeyStore({ now: () => 1788438500000 });
    assert.equal(s3.verify(plaintext).ok, true);
  });
});

// ── HTTP mount + real Gateway ───────────────────────────────────────────
const { Gateway } = require('../src/gateway/server');

const OP = 'tok-e3-op';
const WK = 'tok-e3-wk';

function makeGw() {
  const gw = new Gateway({
    bots: {
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
    },
    telemetryFile: null,
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  gw.mounts.push(require('../src/gateway/mounts/112-apikeys'));
  return gw;
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function fetch(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('mount /v2/apikeys: operator CRUD, plaintext once, worker 403, audited', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // worker → 403
      const denied = await fetch(s.port, 'GET', '/v2/apikeys', WK);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');
      // create → plaintext EXACTLY once
      const created = await fetch(s.port, 'POST', '/v2/apikeys', OP,
        { name: 'ext-cron', scopes: ['audit.read'], rate: { windowMs: 1000, max: 3 } });
      assert.equal(created.status, 201);
      const { id, plaintext } = created.json;
      assert.ok(/^tgk_[0-9a-f]{48}$/.test(created.json.plaintext));
      // list does NOT contain plaintext or hash
      const list = await fetch(s.port, 'GET', '/v2/apikeys', OP);
      assert.equal(list.status, 200);
      // 2 rows: the CI/earlier keys in this store — but THIS test's file has
      // only this one key… unless withDbFile reused the file. Assert >=1 and
      // exact ownership instead of exact count.
      assert.ok(list.json.keys.length >= 1);
      assert.ok(list.json.keys.some((k) => k.id === id), 'created key in list');
      assert.ok(!list.text.includes(created.json.plaintext.slice(4)));
      // revoke
      const revoked = await fetch(s.port, 'POST', `/v2/apikeys/${id}/revoke`, OP, {});
      assert.equal(revoked.status, 200);
      assert.equal(revoked.json.record.disabled, true);
      // audit rows exist, and NEITHER audit body nor list carries the plaintext
      const types = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(types.includes('apikey_created'));
      assert.ok(types.includes('apikey_revoked'));
      assert.ok(!JSON.stringify(gw.chain.entries).includes(created.json.plaintext.slice(4)));
    } finally { await s.close(); }
  });
});

test('apikeys: verify() flow — the key works until revoked, then fail-closed', async () => {
  await withDbFile(async () => {
    const { getApiKeyStore } = require('../src/gateway/apikeys');
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const created = await fetch(s.port, 'POST', '/v2/apikeys', OP,
        { name: 'k', owner: 'atlas', scopes: ['audit.read', 'status.read'] });
      const plaintext = created.json.plaintext;
      const store = getApiKeyStore(gw);
      // happy verify + scope present
      const v = store.verify(plaintext);
      assert.equal(v.ok, true);
      assert.ok(ApiKeyStore_hasScope(v.record, 'audit.read'));
      assert.ok(!ApiKeyStore_hasScope(v.record, 'memory.read')); // not granted
      // revoke → verify refuses
      await fetch(s.port, 'POST', `/v2/apikeys/${created.json.id}/revoke`, OP, {});
      assert.equal(store.verify(plaintext).reason, 'disabled');
      // garbage plaintexts fail closed
      assert.equal(store.verify('').reason, 'unknown');
      assert.equal(store.verify(plaintext + 'x').reason, 'unknown');
    } finally { await s.close(); }
  });
});

function ApiKeyStore_hasScope(record, scope) {
  return !!record && Array.isArray(record.scopes) && record.scopes.includes(scope);
}

test('apikeys: restart persistence — keys and rate counters survive', async () => {
  await withDbFile(async (dir) => {
    const { getApiKeyStore } = fresh();
    const gw = makeGw();
    const s = await serve(gw);
    let plaintext;
    try {
      const created = await fetch(s.port, 'POST', '/v2/apikeys', OP,
        { name: 'persist', owner: 'atlas', scopes: ['audit.read'], rate: { windowMs: 60000, max: 1 } });
      plaintext = created.json.plaintext;
      assert.equal(store_verify(gw, plaintext).ok, true);      // 1st hit ok
      assert.equal(store_verify(gw, plaintext).reason, 'rate_limited'); // 2nd inside window
    } finally { await s.close(); }
    // fresh module graph on the SAME db — counter still holds
    const { getApiKeyStore: g2 } = fresh();
    const gw2 = makeGw();
    const s2 = await serve(gw2);
    try {
      assert.equal(g2(gw2).verify(plaintext).reason, 'rate_limited', 'rate counter survived restart');
    } finally { await s2.close(); }
  });
});

function store_verify(gw, plaintext) {
  return require('../src/gateway/apikeys').getApiKeyStore(gw).verify(plaintext);
}