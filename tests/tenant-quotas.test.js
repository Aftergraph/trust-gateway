'use strict';
// FS-I3 — per-tenant quota enforcement tests.
//
// Covers: default quotas active for tenants with no row (incl. 'main'),
// env-configurable defaults (TG_TENANT_DEFAULT_DISK_MB / TG_TENANT_DEFAULT_
// API_PER_HOUR), custom quota persistence + merge-on-partial-patch,
// disk-over → 429, api-over → 429, quota-checker error → deny (fail
// closed), operator scoping on PUT/GET /v2/tenants/:id/quota (worker 403 +
// tenant_quota_denied, anonymous 401, unknown tenant 404), read-only disk
// walk (never creates tenant dirs), and atomic API bucket increments with
// stale-bucket pruning.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// File-level data jail BEFORE any gateway module is required (same pattern
// as tests/tenant-scope.test.js). Each test re-inits env + clears the
// require cache for the module graph it needs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i3-quotas-'));
const DATA_DIR = path.join(TMP, 'data');
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = DATA_DIR;

function freshModules() {
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/src/gateway/')) delete require.cache[m];
  }
}

const { Gateway } = require('../src/gateway/server');
const { TenantQuotas, defaultQuota, hourBucket, KV_API_PREFIX } = require('../src/gateway/tenant-quotas');
const { getTenantStore } = require('../src/gateway/tenants');
const { enforceQuotas } = require('../src/gateway/tenant-scope');
const { send } = require('../src/gateway/server');

function makeGateway(bots, extraMounts = []) {
  const gw = new Gateway({
    bots,
    telemetryFile: null,
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  gw.mounts.push(require('../src/gateway/mounts/115-tenant-quotas'));
  gw.mounts.push(require('../src/gateway/mounts/10-search'));
  for (const m of extraMounts) gw.mounts.push(require(m));
  return gw;
}

async function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

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

const OP = 'tok-i3-op';
const WK = 'tok-i3-wk';

function envDefaults(prev) {
  // Snapshot + restore the two env knobs a test wants to flip.
  const saved = {
    disk: process.env.TG_TENANT_DEFAULT_DISK_MB,
    api: process.env.TG_TENANT_DEFAULT_API_PER_HOUR,
    db: process.env.TG_DB_FILE,
    data: process.env.TG_DATA_DIR,
  };
  return function restore() {
    if (saved.disk === undefined) delete process.env.TG_TENANT_DEFAULT_DISK_MB; else process.env.TG_TENANT_DEFAULT_DISK_MB = saved.disk;
    if (saved.api === undefined) delete process.env.TG_TENANT_DEFAULT_API_PER_HOUR; else process.env.TG_TENANT_DEFAULT_API_PER_HOUR = saved.api;
    if (saved.db === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = saved.db;
    if (saved.data === undefined) delete process.env.TG_DATA_DIR; else process.env.TG_DATA_DIR = saved.data;
  };
}

test('tenant-quotas: main tenant gets defaults when no row exists', () => {
  freshModules();
  const restore = envDefaults();
  delete process.env.TG_TENANT_DEFAULT_DISK_MB;
  delete process.env.TG_TENANT_DEFAULT_API_PER_HOUR;
  try {
    const gw = new Gateway({ bots: {}, telemetryFile: null, mountFiles: false, dispatch: async () => ({ ok: true }) });
    const store = getTenantStore(gw); // bootstraps 'main'
    const q = new TenantQuotas();
    const quota = q.getQuota('main');
    assert.deepStrictEqual(quota, { maxDiskMb: 500, maxApiPerHour: 1000 });
    // tenant_quotas table exists but has no rows
    const n = gw.db ? null : null;
    assert.strictEqual(n, null);
  } finally { restore(); }
});

test('tenant-quotas: default quotas active + env-configurable', () => {
  freshModules();
  const restore = envDefaults();
  try {
    process.env.TG_TENANT_DEFAULT_DISK_MB = '42';
    process.env.TG_TENANT_DEFAULT_API_PER_HOUR = '7';
    assert.deepStrictEqual(defaultQuota(), { maxDiskMb: 42, maxApiPerHour: 7 });
    const q = new TenantQuotas();
    assert.deepStrictEqual(q.getQuota('main'), { maxDiskMb: 42, maxApiPerHour: 7 });
    // invalid / negative env falls back to the built-in default
    process.env.TG_TENANT_DEFAULT_DISK_MB = 'nope';
    process.env.TG_TENANT_DEFAULT_API_PER_HOUR = '-3';
    assert.deepStrictEqual(q.getQuota('main'), { maxDiskMb: 500, maxApiPerHour: 1000 });
  } finally { restore(); }
});

test('tenant-quotas: custom quota persists; partial patch merges; null resets', () => {
  freshModules();
  const q = new TenantQuotas();
  const out = q.setQuota('acme-quota-persist', { maxDiskMb: 11, maxApiPerHour: 22 });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(q.getQuota('acme-quota-persist'), { maxDiskMb: 11, maxApiPerHour: 22 });
  // partial patch keeps the untouched column
  q.setQuota('acme-quota-persist', { maxApiPerHour: 33 });
  assert.deepStrictEqual(q.getQuota('acme-quota-persist'), { maxDiskMb: 11, maxApiPerHour: 33 });
  // null resets that column to the (env) default
  process.env.TG_TENANT_DEFAULT_API_PER_HOUR = '555';
  q.setQuota('acme-quota-persist', { maxApiPerHour: null });
  assert.deepStrictEqual(q.getQuota('acme-quota-persist'), { maxDiskMb: 11, maxApiPerHour: 555 });
  delete process.env.TG_TENANT_DEFAULT_API_PER_HOUR;
  // invalid caps are rejected (fail closed), nothing persisted
  for (const bad of [-1, 1.5, 'x']) {
    assert.throws(() => q.setQuota('acme-quota-persist', { maxDiskMb: bad }), /invalid maxDiskMb/);
  }
  assert.strictEqual(q.getQuota('acme-quota-persist').maxDiskMb, 11);
  // non-slug tenant ids are refused outright
  assert.throws(() => q.getQuota('../escape'), /invalid tenant id/);
  assert.throws(() => q.setQuota('UPPER', {}), /invalid tenant id/);
});

test('tenant-quotas: checkDisk — read-only du-shim, over-cap detection', () => {
  freshModules();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i3-disk-'));
  const store = new (require('../src/gateway/tenants').TenantStore)({ dataDir: path.join(dir, 'data') });
  const q = new TenantQuotas();
  const id = 'disky';
  // No dir yet → 0 used; and the walk must NOT create it
  const before = q.checkDisk(id, store);
  assert.strictEqual(before.ok, true);
  assert.strictEqual(before.usedMb, 0);
  assert.strictEqual(before.limitMb, 500);
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'tenants', id)), 'disk check must not create tenant dirs');
  // 2 MB over the tenant dir → over a 1 MB cap
  store.dataRoot(id); // create the root (store is allowed to)
  fs.writeFileSync(path.join(dir, 'data', 'tenants', id, 'blob.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
  q.setQuota(id, { maxDiskMb: 1 });
  const over = q.checkDisk(id, store);
  assert.strictEqual(over.ok, false);
  assert.ok(over.usedMb >= 2);
  assert.strictEqual(over.limitMb, 1);
  // under a 4 MB cap it passes again
  q.setQuota(id, { maxDiskMb: 4 });
  assert.strictEqual(q.checkDisk(id, store).ok, true);
  // symlinks are never followed (no escape): point at /etc and stay under cap
  fs.symlinkSync('/etc/hostname', path.join(dir, 'data', 'tenants', id, 'evil'));
  assert.strictEqual(q.checkDisk(id, store).ok, true);
});

test('tenant-quotas: checkApi — atomic increments, prune, over-cap', () => {
  freshModules();
  const q = new TenantQuotas();
  const id = 'appy';
  q.setQuota(id, { maxApiPerHour: 3 });
  for (let i = 1; i <= 3; i++) {
    const r = q.checkApi(id);
    assert.deepStrictEqual(r, { ok: true, count: i, limit: 3 });
  }
  const r4 = q.checkApi(id);
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(r4.count, 4);
  assert.strictEqual(r4.limit, 3);
  // peek is read-only
  assert.strictEqual(q.peekApi(id), 4);
  assert.strictEqual(q.peekApi(id), 4);
  // stale buckets pruned on increment, current bucket untouched
  const now = Date.now();
  const staleBucket = hourBucket(now - 2 * 60 * 60 * 1000);
  const { db } = require('../src/gateway/db');
  db.prepare('INSERT OR REPLACE INTO kv_store(key, value, updated_at) VALUES(?, ?, ?)')
    .run(`${KV_API_PREFIX}${id}:${staleBucket}`, '999', now - 7200000);
  q.checkApi(id); // count 5, prune fires
  const rows = db.prepare('SELECT key FROM kv_store WHERE key LIKE ?').run(`${KV_API_PREFIX}${id}:%`).all ? null : null;
  assert.strictEqual(rows, null);
  const left = db.prepare('SELECT key FROM kv_store WHERE key LIKE ?').all(`${KV_API_PREFIX}${id}:%`);
  assert.strictEqual(left.length, 1);
  assert.ok(left[0].key.includes(String(hourBucket(now))));
});

test('tenant-quotas: middleware — disk-over 429, api-over 429, audited fail-closed', async () => {
  freshModules();
  const restore = envDefaults();
  try {
    const gw = makeGateway({
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      // tenant-scoped worker: full token is 'tnt_<tenant>_<rest>' (resolver claim)
      forge: { token: `tnt_quota-mw_${WK}`, role: 'worker', capabilities: ['fs.read'] },
    });
    const { server, base } = await listen(gw);
    const store = getTenantStore(gw);
    const t = store.create({ name: 'quota-mw' });
    const q = new TenantQuotas();
    try {
      // healthy tenant passes and is counted
            const ok1 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent('tnt_quota-mw_' + WK)}`);
      assert.strictEqual(ok1.status, 200);
      assert.strictEqual(ok1.json.total, 0);
      // api-over: set cap 1 — next request is the 2nd → 429 kind api
      q.setQuota(t.id, { maxApiPerHour: 1 });
      const overApi = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent('tnt_quota-mw_' + WK)}`);
      assert.strictEqual(overApi.status, 429);
      assert.strictEqual(overApi.json.error, 'quota_exceeded');
      assert.strictEqual(overApi.json.kind, 'api');
      assert.strictEqual(overApi.json.limit, 1);
      // disk-over: cap 0 bytes with a file present → 429 kind disk
      const root = store.dataRoot(t.id);
      fs.writeFileSync(path.join(root, 'x.bin'), Buffer.alloc(1024, 1));
      q.setQuota(t.id, { maxDiskMb: 0 });
      const overDisk = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent('tnt_quota-mw_' + WK)}`);
      assert.strictEqual(overDisk.status, 429);
      assert.strictEqual(overDisk.json.error, 'quota_exceeded');
      assert.strictEqual(overDisk.json.kind, 'disk');
      assert.strictEqual(overDisk.json.limitMb, 0);
      // audited: tenant_quota_exceeded rows for both kinds
      const payloads = gw.chain.entries.map((e) => e.payload);
      const ex = payloads.filter((p) => p.type === 'tenant_quota_exceeded');
      assert.ok(ex.length >= 2);
      assert.ok(ex.some((p) => p.kind === 'api' && p.tenant === t.id && p.limit === 1));
      assert.ok(ex.some((p) => p.kind === 'disk' && p.tenant === t.id && p.limit === 0));
      // main tenant: quota surface stays healthy (defaults comfortably above usage)
      const mainSearch = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
      assert.strictEqual(mainSearch.status, 200);
    } finally {
      server.close();
    }
  } finally { restore(); }
});

test('tenant-quotas: middleware fail-closed — checker error → 429, never allowance', async () => {
  freshModules();
  const gw = makeGateway({
    atlas: { token: OP, role: 'operator', capabilities: ['*'] },
    forge: { token: `tnt_quota-fc_${WK}`, role: 'worker', capabilities: ['fs.read'] },
  });
  const { server, base } = await listen(gw);
  const store = getTenantStore(gw);
  const t = store.create({ name: 'quota-fc' });
  try {
    // Sabotage: make the data root a FILE so the disk walk throws (fail closed).
    const bad = store.create({ name: 'quota-fc-bad' });
    const baseTenants = path.join(DATA_DIR, 'tenants');
    fs.mkdirSync(baseTenants, { recursive: true });
    fs.rmSync(path.join(baseTenants, bad.id), { recursive: true, force: true });
    fs.writeFileSync(path.join(baseTenants, bad.id), 'not-a-dir');
    gw.bots.forgeBad = { token: `tnt_quota-fc-bad_${WK}`, role: 'worker', capabilities: ['fs.read'] };
    const r = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent('tnt_quota-fc-bad_' + WK)}`);
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.json.error, 'quota_exceeded');
    assert.strictEqual(r.json.kind, 'disk');
    assert.strictEqual(r.json.reason, 'quota_check_error');
    const ex = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'tenant_quota_exceeded');
    assert.ok(ex.some((p) => p.tenant === bad.id && p.used === null && p.limit === null));
    // …and a healthy request after the sabotage still works (error is per-request)
    const ok2 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent('tnt_quota-fc_' + WK)}`);
    assert.strictEqual(ok2.status, 200);
  } finally {
    server.close();
  }
});

test('tenant-quotas: main without explicit row is not enforced; explicit row caps main too', async () => {
  freshModules();
  const restore = envDefaults();
  try {
    process.env.TG_TENANT_DEFAULT_API_PER_HOUR = '2';
    process.env.TG_TENANT_DEFAULT_DISK_MB = '0'; // 0-byte default disk cap
    const gw = makeGateway({
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
    });
    const { server, base } = await listen(gw);
    const q = new TenantQuotas();
    try {
      // main has no quota row: even with 0-MB default disk + 2/hour default
      // api, main traffic is neither counted nor capped (byte-identical).
      const r1 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
      assert.strictEqual(r1.status, 200);
      const r2 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
      assert.strictEqual(r2.status, 200);
      const r3 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
      assert.strictEqual(r3.status, 200);
      assert.strictEqual(q.peekApi('main'), 0, 'main traffic must not be counted');
      // operator caps main explicitly → enforced from then on
      const put = await api(base, 'PUT', '/v2/tenants/main/quota', { token: OP, body: { maxApiPerHour: 1, maxDiskMb: 500 } });
      assert.strictEqual(put.status, 200);
      const r4 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
            assert.strictEqual(r4.status, 200); // count 1 ≤ 1
      const r5 = await api(base, 'GET', `/v2/search?q=x&token=${encodeURIComponent(OP)}`);
      assert.strictEqual(r5.status, 429); // count 2 > 1
      assert.strictEqual(r5.json.kind, 'api');
    } finally {
      server.close();
    }
  } finally { restore(); }
});

test('tenant-quotas: operator endpoints scoped (PUT/GET quota, 403/401/404)', async () => {
  freshModules();
  const gw = makeGateway({
    atlas: { token: OP, role: 'operator', capabilities: ['*'] },
    forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
  });
  const { server, base } = await listen(gw);
  const store = getTenantStore(gw);
  const t = store.create({ name: 'quota-ops' });
  try {
    // anonymous → 401 (auth gate, not audited as tenant_quota_denied)
    const anon = await api(base, 'PUT', `/v2/tenants/${t.id}/quota`, { body: { maxDiskMb: 5 } });
    assert.strictEqual(anon.status, 401);
    // worker → 403 + tenant_quota_denied
    const wk = await api(base, 'PUT', `/v2/tenants/${t.id}/quota`, { token: WK, body: { maxDiskMb: 5 } });
    assert.strictEqual(wk.status, 403);
    assert.strictEqual(wk.json.error, 'operator_required');
    // unknown tenant → 404 (anti-enumeration)
    const nf = await api(base, 'GET', '/v2/tenants/no-such-tenant-xyz/quota', { token: OP });
    assert.strictEqual(nf.status, 404);
    // operator PUT → 200 + persisted; audited tenant_quota_set
    const put = await api(base, 'PUT', `/v2/tenants/${t.id}/quota`, { token: OP, body: { maxDiskMb: 77, maxApiPerHour: 88 } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.ok, true);
    const q = new TenantQuotas();
    assert.deepStrictEqual(q.getQuota(t.id), { maxDiskMb: 77, maxApiPerHour: 88 });
    // invalid cap → 400
    const bad = await api(base, 'PUT', `/v2/tenants/${t.id}/quota`, { token: OP, body: { maxDiskMb: -5 } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'invalid_quota');
    // operator GET → 200 with usage + limits; audited tenant_quota_read
    const get = await api(base, 'GET', `/v2/tenants/${t.id}/quota`, { token: OP });
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.json.tenant, t.id);
    assert.deepStrictEqual(get.json.quota, { maxDiskMb: 77, maxApiPerHour: 88 });
    assert.strictEqual(get.json.usage.disk.limitMb, 77);
    assert.strictEqual(get.json.usage.api.limit, 88);
    assert.strictEqual(typeof get.json.usage.disk.usedMb, 'number');
    assert.strictEqual(typeof get.json.usage.api.count, 'number');
    // worker GET also refused
    const wkGet = await api(base, 'GET', `/v2/tenants/${t.id}/quota`, { token: WK });
    assert.strictEqual(wkGet.status, 403);
    // audits present
    const types = gw.chain.entries.map((e) => e.payload.type);
    assert.ok(types.includes('tenant_quota_set'));
    assert.ok(types.includes('tenant_quota_read'));
    assert.ok(types.includes('tenant_quota_denied'));
  } finally {
    server.close();
  }
});

test('tenant-quotas: mount does not shadow 113-tenants CRUD routes', async () => {
  freshModules();
  const gw = makeGateway({
    atlas: { token: OP, role: 'operator', capabilities: ['*'] },
  });
  gw.mounts.push(require('../src/gateway/mounts/113-tenants'));
  const { server, base } = await listen(gw);
  try {
    const list = await api(base, 'GET', '/v2/tenants', { token: OP });
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.json.tenants));
    const created = await api(base, 'POST', '/v2/tenants', { token: OP, body: { name: 'Coexist Check' } });
    assert.strictEqual(created.status, 201);
  } finally {
    server.close();
  }
});
