'use strict';
// FS-E1 slice 3 — tenant CRUD mount + whoami tenant enrichment tests.
//
// Covers: operator CRUD on /v2/tenants (list without secrets, create,
// disable/enable, invalid name, unknown id), worker 403 + tenant_denied
// audit, anonymous 401, the four audit rows, /v2/me carrying the tenant id
// for the default ('main') and an explicit operator-selected tenant,
// non-operator X-Tenant ignored (falls back to 'main'), disabled explicit
// tenant → field omitted (anti-enumeration), and byte-identical main
// behavior (old body shape + exactly one added field).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1c-'));
  const prevDb = process.env.TG_DB_FILE;
  const prevData = process.env.TG_DATA_DIR;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  process.env.TG_DATA_DIR = path.join(dir, 'data');
  process.chdir(dir);
  const done = () => {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = prevDb;
    if (prevData === undefined) delete process.env.TG_DATA_DIR; else process.env.TG_DATA_DIR = prevData;
  };
  return Promise.resolve().then(() => fn(dir)).finally(done);
}

// Fresh module graph per test: db.js is a process singleton — clearing it
// AFTER the env is set (but BEFORE anything requires it) gives each test its
// own db file. Never clear it under a RUNNING gateway.
function freshGateway() {
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/tenants.js') ||
        m.endsWith('/src/gateway/tenant-resolve.js') ||
        m.endsWith('/src/gateway/mounts/113-tenants.js') ||
        m.endsWith('/src/gateway/mounts/102-identity.js')) delete require.cache[m];
  }
  const { Gateway } = require('../src/gateway/server');
  return { Gateway };
}

const OP = 'tok-e1c-op';
const WK = 'tok-e1c-wk';

function makeGw() {
  const { Gateway } = freshGateway();
  const gw = new Gateway({
    bots: {
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
    },
    telemetryFile: null,
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  gw.mounts.push(require('../src/gateway/mounts/113-tenants'));
  gw.mounts.push(require('../src/gateway/mounts/102-identity'));
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

function fetch(port, method, p, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {},
        extraHeaders || {}),
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

function auditTypes(gw) {
  return gw.chain.entries.map((e) => e.payload.type);
}

test('tenants mount: operator CRUD happy path; list carries no secrets; audited', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // default store has exactly 'main', projected without extra fields
      const list0 = await fetch(s.port, 'GET', '/v2/tenants', OP);
      assert.equal(list0.status, 200);
      assert.ok(list0.json.tenants.some((t) => t.id === 'main'));
      for (const t of list0.json.tenants) {
        assert.deepEqual(Object.keys(t).sort(), ['created_at', 'disabled', 'id', 'name']);
      }
      // create
      const created = await fetch(s.port, 'POST', '/v2/tenants', OP, { name: 'Acme Corp' });
      assert.equal(created.status, 201);
      assert.equal(created.json.id, 'acme-corp');
      assert.equal(created.json.record.name, 'Acme Corp');
      assert.equal(created.json.record.disabled, false);
      // in list now
      const list1 = await fetch(s.port, 'GET', '/v2/tenants', OP);
      assert.ok(list1.json.tenants.some((t) => t.id === 'acme-corp'));
      // disable → enable
      const dis = await fetch(s.port, 'POST', '/v2/tenants/acme-corp/disable', OP, {});
      assert.equal(dis.status, 200);
      assert.equal(dis.json.record.disabled, true);
      const en = await fetch(s.port, 'POST', '/v2/tenants/acme-corp/enable', OP, {});
      assert.equal(en.status, 200);
      assert.equal(en.json.record.disabled, false);
      // fail-closed inputs: invalid name → 400; unknown id → 404
      const bad = await fetch(s.port, 'POST', '/v2/tenants', OP, { name: 'x' });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'invalid_name');
      const ghost = await fetch(s.port, 'POST', '/v2/tenants/ghost/disable', OP, {});
      assert.equal(ghost.status, 404);
      // audit rows, exact payloads
      const types = auditTypes(gw);
      assert.ok(types.includes('tenant_created'));
      assert.ok(types.includes('tenant_disabled'));
      assert.ok(types.includes('tenant_enabled'));
      const createdRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'tenant_created');
      assert.deepEqual(Object.keys(createdRow).sort(), ['id', 'name', 'type']);
      assert.equal(createdRow.id, 'acme-corp');
      assert.equal(createdRow.name, 'Acme Corp');
      const disRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'tenant_disabled');
      assert.deepEqual(Object.keys(disRow).sort(), ['id', 'type']);
      const enRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'tenant_enabled');
      assert.deepEqual(Object.keys(enRow).sort(), ['id', 'type']);
    } finally { await s.close(); }
  });
});

test('tenants mount: worker 403 + tenant_denied audited; anonymous 401', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const denied = await fetch(s.port, 'GET', '/v2/tenants', WK);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');
      const deniedPost = await fetch(s.port, 'POST', '/v2/tenants', WK, { name: 'Nope Inc' });
      assert.equal(deniedPost.status, 403);
      const rows = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'tenant_denied');
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.deepEqual(Object.keys(r).sort(), ['bot', 'type']);
        assert.equal(r.bot, 'forge');
      }
      // nothing was created by the refused call
      const list = await fetch(s.port, 'GET', '/v2/tenants', OP);
      assert.ok(!list.json.tenants.some((t) => t.id === 'nope-inc'));
      // anonymous → 401 at the mount runner (bearer), never a tenant body
      const anon = await fetch(s.port, 'GET', '/v2/tenants', null);
      assert.equal(anon.status, 401);
    } finally { await s.close(); }
  });
});

test('/v2/me carries tenant: default main (byte-identical + one field), explicit operator tenant, non-operator header ignored, disabled explicit tenant omitted', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // byte-identical main behavior: the pre-slice bearer body PLUS exactly
      // the tenant field — no other key added, removed or reordered in value.
      const me = await fetch(s.port, 'GET', '/v2/me', WK);
      assert.equal(me.status, 200);
      assert.deepEqual(me.json, {
        name: 'forge',
        role: 'worker',
        capabilities: ['fs.read'],
        tenant: 'main',
      });
      // operator creates an explicit tenant, then selects it via X-Tenant
      const created = await fetch(s.port, 'POST', '/v2/tenants', OP, { name: 'Acme Corp' });
      assert.equal(created.status, 201);
      const meOp = await fetch(s.port, 'GET', '/v2/me', OP, undefined, { 'x-tenant': 'acme-corp' });
      assert.equal(meOp.status, 200);
      assert.equal(meOp.json.tenant, 'acme-corp');
      // non-operator header is IGNORED (never honoured, never leaked) → main
      const meWk = await fetch(s.port, 'GET', '/v2/me', WK, undefined, { 'x-tenant': 'acme-corp' });
      assert.equal(meWk.status, 200);
      assert.equal(meWk.json.tenant, 'main');
      // unknown tenant on an explicit operator header → resolver answers
      // tenant:null → field OMITTED (anti-enumeration: no 403, no 404 here)
      const meGhost = await fetch(s.port, 'GET', '/v2/me', OP, undefined, { 'x-tenant': 'ghost' });
      assert.equal(meGhost.status, 200);
      assert.equal(meGhost.json.tenant, undefined);
      // disabled tenant → same: field omitted, identity never locks out
      await fetch(s.port, 'POST', '/v2/tenants/acme-corp/disable', OP, {});
      const meDis = await fetch(s.port, 'GET', '/v2/me', OP, undefined, { 'x-tenant': 'acme-corp' });
      assert.equal(meDis.status, 200);
      assert.equal(meDis.json.tenant, undefined);
      // re-enable → header works again
      await fetch(s.port, 'POST', '/v2/tenants/acme-corp/enable', OP, {});
      const meBack = await fetch(s.port, 'GET', '/v2/me', OP, undefined, { 'x-tenant': 'acme-corp' });
      assert.equal(meBack.json.tenant, 'acme-corp');
      // anonymous stays 401 (identity resolution unchanged)
      const anon = await fetch(s.port, 'GET', '/v2/me', null);
      assert.equal(anon.status, 401);
      assert.deepEqual(anon.json, { error: 'unauthorized' });
    } finally { await s.close(); }
  });
});
