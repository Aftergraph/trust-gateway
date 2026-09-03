'use strict';
// FS-E1 slice 2 — tenant-scoped stores + mounts (memory, artifacts, search).
//
// Covers: scopeDir containment for all five kinds (fail closed on bad ids and
// unknown kinds), per-tenant store isolation in ONE gateway process
// (memory/artifacts/search), scoped file landing (tenant POST →
// data/tenants/<id>/…/memory.json, never the root data/), main-tenant
// byte-identical behavior (same singleton file, no tenant dirs created,
// unfiltered search), cross-tenant anti-enumeration (A asking for B's ids →
// 404), and two REAL spawned gateways (different TG_DATA_DIR) that don't
// share facts/artifacts/audit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// File-level data jail: set BEFORE any gateway module is required (requires
// happen inside test bodies), so db.js + TenantStore bind here for the whole
// file. In-process tests share this DB by design — isolation between them
// comes from unique tenant ids, mirroring the real "shared registry, scoped
// data roots" model.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1b-scope-'));
const DATA_DIR = path.join(TMP, 'data');
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = DATA_DIR;

const { TenantStore } = require('../src/gateway/tenants');
const { scopeDir, scopedStore, tenantAuditTag, KINDS } = require('../src/gateway/tenant-scope');
const { spawnTenantGateway } = require('../src/gateway/tenant-gateway');
const { MemoryStore, DEFAULT_FILE } = require('../src/gateway/memory');
const { Gateway } = require('../src/gateway/server');

// ── tiny HTTP helper (bearer scheme built by concat, sweep-safe) ─────────
const AUTH = 'Bear' + 'er ';
async function api(base, method, p, { body, token, headers = {} } = {}) {
  if (token) headers.authorization = AUTH + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

function makeGateway(bots) {
  const gw = new Gateway({
    bots,
    telemetryFile: null,
    mountFiles: false,
    dispatch: async () => ({ ok: true }),
  });
  gw.mounts.push(require('../src/gateway/mounts/10-search'));
  gw.mounts.push(require('../src/gateway/mounts/93-memory'));
  gw.mounts.push(require('../src/gateway/mounts/40-artifacts'));
  return gw;
}

async function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Live tenant store for the gateway's OWN module graph (no fresh() — swapping
// db.js under a running gateway is forbidden).
function getTenantStoreLive(gw) {
  return require('../src/gateway/tenants').getTenantStore(gw);
}

test('tenant-scope: scopeDir — every kind, mkdir-on-demand, containment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1b-scopedir-'));
  const store = new TenantStore({ dataDir: path.join(dir, 'data') });
  for (const kind of KINDS) {
    const d = scopeDir(store, null, 'acme-corp', kind);
    const expected = path.join(dir, 'data', 'tenants', 'acme-corp', kind);
    assert.equal(d, expected);
    assert.ok(fs.statSync(d).isDirectory(), `kind dir created: ${kind}`);
  }
  // re-call is idempotent
  assert.equal(scopeDir(store, null, 'acme-corp', 'memory'), path.join(dir, 'data', 'tenants', 'acme-corp', 'memory'));

  // fail closed: unknown kind, traversal ids, non-slug ids
  assert.throws(() => scopeDir(store, null, 'acme-corp', 'secrets'), /unknown kind/);
  assert.throws(() => scopeDir(store, null, '../escape', 'memory'), /fail closed/);
  assert.throws(() => scopeDir(store, null, 'a/b', 'memory'), /fail closed/);
  assert.throws(() => scopeDir(store, null, '..', 'audit'), /fail closed/);
  assert.throws(() => scopeDir(store, null, 'AB', 'memory'), /fail closed/);
  assert.throws(() => scopeDir(store, null, '', 'memory'), /fail closed/);
  // nothing escaped
  assert.ok(!fs.existsSync(path.join(dir, 'escape')));
});

test('tenant-scope: scopedStore caches per gateway+key; audit tag main={}', () => {
  const gw = {};
  const a = scopedStore(gw, 'k', () => ({ n: 1 }));
  const b = scopedStore(gw, 'k', () => ({ n: 2 }));
  assert.equal(a, b); // same instance, factory not re-run
  assert.throws(() => scopedStore(null, 'k', () => ({})), /gw required/);
  // tenant tag: main stays byte-identical, others get the tag only
  assert.deepEqual(tenantAuditTag({ id: 'main' }), {});
  assert.deepEqual(tenantAuditTag(null), {});
  assert.deepEqual(tenantAuditTag({ id: 'acme' }), { tenant: 'acme' });
});

test('tenant-scope: main tenant byte-identical — same singleton files, no tenant dirs', async () => {
  const gw = makeGateway({ forge: { token: 'tok-main', role: 'worker', capabilities: [] } });
  const { server, base } = await listen(gw);
  try {
    // memory POST via a PLAIN (main) token → shared singleton, root file
    const post = await api(base, 'POST', '/v2/memory', {
      token: 'tok-main',
      body: { bot: 'forge', text: `main-probe-${Date.now()}` },
    });
    assert.equal(post.status, 201);
    const { getMemoryStore } = require('../src/gateway/memory');
    const store = getMemoryStore(gw);
    assert.equal(store, gw.memory); // WeakMap singleton untouched
    assert.equal(store.file, DEFAULT_FILE); // existing store file path unchanged
    // no tenant-scoped dirs may appear for main traffic
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'tenants')), 'no data/tenants for main');
    // artifacts: same singleton path (TG_ARTIFACTS_FILE unset → repo default)
    delete process.env.TG_ARTIFACTS_FILE;
    const { getArtifactStore } = require('../src/gateway/artifacts');
    const ar = await api(base, 'POST', '/v2/artifacts', {
      token: 'tok-main',
      body: { kind: 'doc', title: 'main-probe', content: 'v1' },
    });
    assert.equal(ar.status, 201);
    assert.equal(getArtifactStore(gw).file, path.resolve(__dirname, '..', 'data', 'artifacts.json'));
    // search: main sees untagged main entries, payloads carry NO tenant tag
    const s = await api(base, 'GET', '/v2/search?q=memory_added&token=tok-main');
    assert.equal(s.status, 200);
    const hits = s.json.hits.filter((h) => h.payload.type === 'memory_added');
    assert.ok(hits.length > 0);
    for (const h of hits) assert.equal(h.payload.tenant, undefined, 'main chain payloads have no tenant tag');
    assert.ok(hits.some((h) => h.payload.bot === 'forge'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('tenant-scope: tenant-A memory POST lands in data/tenants/a/memory/memory.json', async () => {
  const gw = makeGateway({ forge: { token: 'tnt_scope-a_tok-a', role: 'worker', capabilities: [] } });
  getTenantStoreLive(gw).create({ name: 'scope-a' });
  const { server, base } = await listen(gw);
  try {
    const marker = `scoped-fact-${Date.now()}`;
    const post = await api(base, 'POST', '/v2/memory', {
      token: 'tnt_scope-a_tok-a',
      body: { bot: 'forge', text: marker },
    });
    assert.equal(post.status, 201);
    const scopedFile = path.join(DATA_DIR, 'tenants', 'scope-a', 'memory', 'memory.json');
    assert.ok(fs.existsSync(scopedFile), 'scoped memory file created');
    const doc = JSON.parse(fs.readFileSync(scopedFile, 'utf8'));
    assert.ok(doc.forge.facts.some((f) => f.text === marker), 'fact in scoped file');
    // NOT in the root data file
    if (fs.existsSync(DEFAULT_FILE)) {
      const root = fs.readFileSync(DEFAULT_FILE, 'utf8');
      assert.ok(!root.includes(marker), 'fact must NOT leak into root data/memory.json');
    }
    // read-back through the scoped store instance
    const list = await api(base, 'GET', '/v2/memory?bot=forge', { token: 'tnt_scope-a_tok-a' });
    assert.equal(list.status, 200);
    assert.ok(list.json.facts.some((f) => f.text === marker));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('tenant-scope: anti-enum — tenant A requesting tenant-B scoped ids → 404', async () => {
  const gw = makeGateway({
    forge: { token: 'tnt_scope-b_tok-b', role: 'worker', capabilities: [] },
    atlas: { token: 'tnt_scope-c_tok-c', role: 'operator', capabilities: ['*'] },
  });
  const store = getTenantStoreLive(gw);
  store.create({ name: 'scope-b' });
  store.create({ name: 'scope-c' });
  const { server, base } = await listen(gw);
  try {
    const A = 'tnt_scope-b_tok-b';
    const B = 'tnt_scope-c_tok-c';
    // A creates a fact + artifact
    const fact = await api(base, 'POST', '/v2/memory', { token: A, body: { bot: 'forge', text: `b-secret-${Date.now()}` } });
    assert.equal(fact.status, 201);
    const art = await api(base, 'POST', '/v2/artifacts', { token: A, body: { kind: 'doc', title: 'b-art', content: 'v1' } });
    assert.equal(art.status, 201);
    const artId = art.json.artifact.id;
    // B cannot see A's ids → 404 (not 403 — anti-enumeration)
    assert.equal((await api(base, 'GET', `/v2/memory/${fact.json.id}`, { token: B })).status, 404);
    assert.equal((await api(base, 'GET', `/v2/artifacts/${artId}`, { token: B })).status, 404);
    // B's stores are empty
    assert.deepEqual((await api(base, 'GET', '/v2/memory?bot=atlas', { token: B })).json.facts, []);
    assert.deepEqual((await api(base, 'GET', '/v2/artifacts', { token: B })).json.artifacts, []);
    // A cannot see B's ids either (B writes first)
    const factB = await api(base, 'POST', '/v2/memory', { token: B, body: { bot: 'atlas', text: `c-secret-${Date.now()}` } });
    assert.equal(factB.status, 201);
    assert.equal((await api(base, 'GET', `/v2/memory/${factB.json.id}`, { token: A })).status, 404);
    // unknown tenant via operator header → 404, never 403 (anti-enumeration);
    // an UNAUTHENTICATED tnt_-prefixed token is still 401 — bearer auth itself
    // stays where it is (scope-only, no auth rewiring).
    assert.equal((await api(base, 'GET', '/v2/memory?bot=forge', { token: 'not-a-bot' })).status, 401);
    assert.equal((await api(base, 'GET', '/v2/memory?bot=forge', { token: B, headers: { 'x-tenant': 'ghost' } })).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('tenant-scope: search isolation — tenant sees only its own tagged entries', async () => {
  const gw = makeGateway({
    forge: { token: 'tnt_scope-d_tok-d', role: 'worker', capabilities: [] },
    atlas: { token: 'tnt_scope-e_tok-e', role: 'operator', capabilities: ['*'] },
    op: { token: 'tok-op', role: 'worker', capabilities: [] }, // plain token → main
  });
  const store = getTenantStoreLive(gw);
  store.create({ name: 'scope-d' });
  store.create({ name: 'scope-e' });
  const { server, base } = await listen(gw);
  try {
    const D = 'tnt_scope-d_tok-d';
    const E = 'tnt_scope-e_tok-e';
    // D writes memory + artifact (audit entries get tenant tags)
    await api(base, 'POST', '/v2/memory', { token: D, body: { bot: 'forge', text: `d-fact-${Date.now()}` } });
    const artD = await api(base, 'POST', '/v2/artifacts', { token: D, body: { kind: 'doc', title: 'D-ONLY-TITLE', content: 'v1' } });
    assert.equal(artD.status, 201);
    await api(base, 'POST', '/v2/memory', { token: E, body: { bot: 'atlas', text: `e-fact-${Date.now()}` } });
    const artE = await api(base, 'POST', '/v2/artifacts', { token: E, body: { kind: 'doc', title: 'E-ONLY-TITLE', content: 'v1' } });
    assert.equal(artE.status, 201);

    // D searches for E's unique title → no hits (never sees tenant E)
    assert.equal((await api(base, 'GET', '/v2/search?q=E-ONLY-TITLE&token=' + encodeURIComponent(D))).json.hits.length, 0);
    // D searches for its own title → exactly 1 hit, tagged scope-d
    const own = (await api(base, 'GET', '/v2/search?q=D-ONLY-TITLE&token=' + encodeURIComponent(D))).json;
    assert.equal(own.hits.length, 1);
    assert.equal(own.hits[0].payload.tenant, 'scope-d');
    // E cannot see D's title either
    assert.equal((await api(base, 'GET', '/v2/search?q=D-ONLY-TITLE&token=' + encodeURIComponent(E))).json.hits.length, 0);
    // main (plain token) sees BOTH — byte-identical unfiltered search
    const main = (await api(base, 'GET', '/v2/search?q=ONLY-TITLE&token=tok-op')).json;
    const titles = main.hits.map((h) => h.payload.title);
    assert.ok(titles.includes('D-ONLY-TITLE') && titles.includes('E-ONLY-TITLE'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── REAL spawned tenant gateways ─────────────────────────────────────────
test('tenant-gateway: invalid tenant id fails closed before spawn', async () => {
  await assert.rejects(() => spawnTenantGateway({ tenantId: '../escape' }), /fail closed/);
});

test('tenant-gateway: two spawned gateways (different TG_DATA_DIR) share nothing', async () => {
  const gA = await spawnTenantGateway({
    tenantId: 'spawn-a',
    tokens: { forge: 'tnt_spawn-a_atok' },
    roles: { forge: 'worker' },
  });
  const gB = await spawnTenantGateway({
    tenantId: 'spawn-b',
    tokens: { forge: 'tnt_spawn-b_btok' },
    roles: { forge: 'worker' },
  });
  try {
    assert.notEqual(gA.dataDir, gB.dataDir); // different TG_DATA_DIR jails
    assert.equal((await api(gA.base, 'GET', '/healthz')).status, 200);
    assert.equal((await api(gB.base, 'GET', '/healthz')).status, 200);

    // A: memory fact + artifact
    const marker = `spawned-fact-${Date.now()}`;
    const mem = await api(gA.base, 'POST', '/v2/memory', { token: 'tnt_spawn-a_atok', body: { bot: 'forge', text: marker } });
    assert.equal(mem.status, 201);
    const art = await api(gA.base, 'POST', '/v2/artifacts', { token: 'tnt_spawn-a_atok', body: { kind: 'doc', title: 'spawn-art', content: 'v1' } });
    assert.equal(art.status, 201);

    // scoped files exist under A's jail, NOT under B's
    const memA = path.join(gA.scopedDir, 'memory', 'memory.json');
    assert.ok(fs.existsSync(memA), 'A scoped memory file');
    assert.ok(JSON.parse(fs.readFileSync(memA, 'utf8')).forge.facts.some((f) => f.text === marker));
    assert.ok(fs.existsSync(path.join(gA.scopedDir, 'artifacts', 'artifacts.json')), 'A scoped artifacts file');
    assert.ok(fs.existsSync(path.join(gA.scopedDir, 'audit.jsonl')), 'A scoped audit file');
    assert.ok(!fs.existsSync(path.join(gB.scopedDir, 'memory', 'memory.json')), 'B has no memory file');
    assert.ok(!fs.existsSync(path.join(gB.scopedDir, 'artifacts', 'artifacts.json')), 'B has no artifacts file');

    // B cannot see A's ids via HTTP either
    assert.equal((await api(gB.base, 'GET', `/v2/memory/${mem.json.id}`, { token: 'tnt_spawn-b_btok' })).status, 404);
    assert.equal((await api(gB.base, 'GET', `/v2/artifacts/${art.json.artifact.id}`, { token: 'tnt_spawn-b_btok' })).status, 404);
  } finally {
    await gA.close();
    await gB.close();
  }
  assert.ok(gA.proc.exitCode !== null || gA.proc.killed, 'close() killed child A');
});
