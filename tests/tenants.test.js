'use strict';
// FS-E1 slice 1 — tenant foundation tests.
//
// Covers: TenantStore CRUD (slug validation, collision suffix, disable),
// dataRoot containment (fail-closed on traversal ids), resolver precedence
// matrix (operator header > token prefix > default main), anti-enumeration
// (unknown/disabled → tenant:null, callers answer 404), WeakMap singleton +
// 'main' bootstrap, restart persistence on the same TG_DB_FILE, and the
// healthz mount returning the tenant superset.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1-'));
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
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(done);
}

function fresh() {
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('/src/gateway/db.js') || m.endsWith('/src/gateway/tenants.js') || m.endsWith('/src/gateway/tenant-resolve.js')) {
      delete require.cache[m];
    }
  }
  const { TenantStore, getTenantStore, isValidTenantId, slugify } = require('../src/gateway/tenants');
  const { resolveTenant, isOperatorBot } = require('../src/gateway/tenant-resolve');
  return { TenantStore, getTenantStore, isValidTenantId, slugify, resolveTenant, isOperatorBot };
}

const OP_BOT = { name: 'atlas', role: 'operator', capabilities: ['*'] };
const WORKER = { name: 'forge', role: 'worker', capabilities: [] };

test('tenants: CRUD — create/list/get/setDisabled with slug validation', () => {
  withDbFile(() => {
    const { TenantStore } = fresh();
    const s = new TenantStore();
    const r1 = s.create({ name: 'Acme Corp' });
    assert.equal(r1.ok, true);
    assert.equal(r1.record.id, 'acme-corp');
    assert.equal(r1.record.disabled, false);
    // collision → numeric suffix
    const r2 = s.create({ name: 'Acme Corp' });
    assert.equal(r2.ok, true);
    assert.equal(r2.record.id, 'acme-corp-2');
    // list ordered, both present
    assert.equal(s.list().length, 2);
    // get unknown → null; get non-slug → null (never throws)
    assert.equal(s.get('nope'), null);
    assert.equal(s.get('../etc'), null);
    // disable / re-enable
    const d = s.setDisabled('acme-corp', true);
    assert.equal(d.ok, true);
    assert.equal(s.get('acme-corp').disabled, true);
    s.setDisabled('acme-corp', false);
    assert.equal(s.get('acme-corp').disabled, false);
    // unknown disable → not_found
    assert.equal(s.setDisabled('ghost', true).error, 'not_found');
  });
});

test('tenants: slug rules reject uppercase, short, long, traversal', () => {
  withDbFile(() => {
    const { isValidTenantId, TenantStore } = fresh();
    assert.equal(isValidTenantId('Acme'), false);
    assert.equal(isValidTenantId('ab'), false);            // too short
    assert.equal(isValidTenantId('a'.repeat(25)), false);  // too long
    assert.equal(isValidTenantId('../etc'), false);
    assert.equal(isValidTenantId('a/b'), false);
    assert.equal(isValidTenantId('a..b'), false);
    assert.equal(isValidTenantId('-lead'), false);
    assert.equal(isValidTenantId('ok-id-123'), true);
    const s = new TenantStore();
    assert.equal(s.create({ name: 'x' }).error, 'invalid_name');   // slug too short
    // '../etc' SANITIZES to 'etc' (traversal chars stripped by slugify) —
    // create succeeds with a safe id; the danger is dataRoot('./etc…') raw
    // ids, covered by the containment test above.
    const san = s.create({ name: '../etc' });
    assert.equal(san.ok, true);
    assert.equal(san.record.id, 'etc');
  });
});

test('tenants: dataRoot containment — traversal ids fail closed', () => {
  withDbFile((dir) => {
    const { TenantStore } = fresh();
    const s = new TenantStore({ dataDir: path.join(dir, 'data') });
    const root = s.dataRoot('acme');
    assert.ok(root.startsWith(path.join(dir, 'data', 'tenants') + path.sep));
    fs.writeFileSync(path.join(root, 'probe.txt'), 'x'); // mkdir worked
    assert.throws(() => s.dataRoot('../escape'), /fail closed/);
    assert.throws(() => s.dataRoot('a/b'), /fail closed/);
    assert.throws(() => s.dataRoot('..'), /fail closed/);
    // nothing escaped the base
    assert.ok(!fs.existsSync(path.join(dir, 'escape')));
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'escape')));
  });
});

test('resolver: precedence — operator header > token prefix > default main', () => {
  withDbFile(() => {
    const { TenantStore, getTenantStore, resolveTenant } = fresh();
    const gw = {};
    const s = getTenantStore(gw); // bootstraps main
    s.create({ name: 'Beta Co' }); // id 'beta-co'

    // default → main
    const dflt = resolveTenant({ headers: {} }, gw);
    assert.equal(dflt.tenant.id, 'main');
    assert.equal(dflt.source, 'default');

    // token prefix (any caller) → that tenant
    const tok = resolveTenant({ headers: { authorization: 'Bearer tnt_beta-co_abc123' } }, gw);
    assert.equal(tok.tenant.id, 'beta-co');
    assert.equal(tok.source, 'token');

    // non-operator header is IGNORED → falls to token prefix → beta
    const ignored = resolveTenant(
      { headers: { 'x-tenant': 'main', authorization: 'Bearer tnt_beta-co_abc123' }, bot: WORKER },
      gw
    );
    assert.equal(ignored.tenant.id, 'beta-co');

    // operator header wins over token prefix
    const opHdr = resolveTenant(
      { headers: { 'x-tenant': 'main', authorization: 'Bearer tnt_beta-co_abc123' }, bot: OP_BOT },
      gw
    );
    assert.equal(opHdr.tenant.id, 'main');
    assert.equal(opHdr.source, 'header');

    // req.__tgOperator escape hatch counts as operator
    const flag = resolveTenant(
      { headers: { 'x-tenant': 'main' }, __tgOperator: true },
      gw
    );
    assert.equal(flag.tenant.id, 'main');
  });
});

test('resolver: anti-enumeration — unknown/disabled → tenant null (404 path)', () => {
  withDbFile(() => {
    const { TenantStore, getTenantStore, resolveTenant } = fresh();
    const gw = {};
    const s = getTenantStore(gw);
    s.create({ name: 'Real One' }); // real-one

    // unknown tenant via token prefix → null, source 'token' (caller must 404)
    const unk = resolveTenant({ headers: { authorization: 'Bearer tnt_ghost_x' } }, gw);
    assert.equal(unk.tenant, null);
    // unknown via operator header → null
    const unkH = resolveTenant({ headers: { 'x-tenant': 'ghost' }, bot: OP_BOT }, gw);
    assert.equal(unkH.tenant, null);
    // disabled tenant → null on both paths
    s.setDisabled('real-one', true);
    const dis = resolveTenant({ headers: { authorization: 'Bearer tnt_real-one_x' } }, gw);
    assert.equal(dis.tenant, null);
    const disH = resolveTenant({ headers: { 'x-tenant': 'real-one' }, bot: OP_BOT }, gw);
    assert.equal(disH.tenant, null);
  });
});

test('tenants: main bootstrapped once; restart persistence on same db file', () => {
  withDbFile((dir) => {
    let { TenantStore, getTenantStore } = fresh();
    const gw = {};
    const s = getTenantStore(gw);
    assert.equal(s.get('main').id, 'main');
    s.create({ name: 'Persistent Co' });

    // "restart": fresh module graph on same TG_DB_FILE
    ({ TenantStore, getTenantStore } = fresh());
    const s2 = new TenantStore();
    assert.equal(s2.get('main').id, 'main');
    assert.equal(s2.get('persistent-co').name, 'Persistent Co');
    // ensureMain is idempotent
    assert.equal(s2.ensureMain().id, 'main');
    assert.equal(s2.list().filter((t) => t.id === 'main').length, 1);
  });
});

test('mount tenant-healthz: /healthz returns tenant superset; unknown tenant 404', async () => {
  await withDbFile(async () => {
    const { Gateway } = require('../src/gateway/server');
    const gw = new Gateway({
      bots: { atlas: { token: 'op', role: 'operator', capabilities: ['*'] } },
      telemetryFile: null,
      dispatch: async () => ({ ok: true }),
      mountFiles: false,
    });
    gw.mounts.push(require('../src/gateway/mounts/02-tenant-healthz'));
    const server = http.createServer((req, res) => gw.handle(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const get = (p, headers) => new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path: p, headers }, (rs) => {
        let raw = '';
        rs.on('data', (c) => { raw += c; });
        rs.on('end', () => resolve({ status: rs.statusCode, json: JSON.parse(raw) }));
      });
      rq.end();
    });
    try {
      // default → main superset body
      const dflt = await get('/healthz', {});
      assert.equal(dflt.status, 200);
      assert.equal(dflt.json.ok, true);
      assert.equal(dflt.json.tenant, 'main');
      assert.equal(dflt.json.chain.ok, true);
      // operator header to a real tenant — create via the SAME store the
      // mount's resolver will use (no fresh() here: it would swap the
      // db.js module graph under the running gateway)
      const { getTenantStore } = require('../src/gateway/tenants');
      getTenantStore(gw).create({ name: 'Hdr Co' });
      const hdr = await get('/healthz', { 'x-tenant': 'hdr-co', authorization: 'Bearer op' });
      assert.equal(hdr.status, 200);
      assert.equal(hdr.json.tenant, 'hdr-co');
      // unknown tenant → 404 not_found (anti-enumeration)
      const unk = await get('/healthz', { 'x-tenant': 'ghost', authorization: 'Bearer op' });
      assert.equal(unk.status, 404);
      // disabled tenant → 404 as well (same live store, no module swap)
      const { getTenantStore: g2 } = require('../src/gateway/tenants');
      g2(gw).setDisabled('hdr-co', true);
      const dis = await get('/healthz', { 'x-tenant': 'hdr-co', authorization: 'Bearer op' });
      assert.equal(dis.status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});