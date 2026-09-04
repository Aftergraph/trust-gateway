const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway/server');

// Contract tests for the fn-route dispatch wiring (server.js router facade).
// These pin the LIVE gateway behavior that the 2026-09-04 smoke exposed:
// req.bot must be set on raw req, :param paths must match, RBAC must gate.

describe('fn-route dispatch contract', () => {
  let gw;

  before(() => {
    gw = new Gateway({ mountFiles: true, mountFilesBots: undefined });
  });

  it('wires function-style mounts into _fnRoutes', () => {
    assert.ok(Array.isArray(gw._fnRoutes));
    assert.ok(gw._fnRoutes.length >= 60, `expected >=60 fn routes, got ${gw._fnRoutes.length}`);
  });

  it('matcher supports :param segments', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/metrics/tenant/acme');
    assert.ok(m, ':param path must match');
    assert.ok(m.params && m.params[1] === 'acme');
  });

  it('matcher does not cross methods', () => {
    const m = gw._matchFunctionRoute('DELETE', '/v2/metrics/tenant/acme');
    assert.equal(m, null);
  });

  it('matcher returns null for unknown paths', () => {
    assert.equal(gw._matchFunctionRoute('GET', '/v2/nope/missing'), null);
  });

  it('matcher handles exact string paths', () => {
    const m = gw._matchFunctionRoute('GET', '/v2/dashboard');
    assert.ok(m, 'exact path must match');
  });

  it('isOperator(req) sees bot role from dispatch (req.bot)', async () => {
    const { isOperator } = require('../src/gateway/tenants');
    const fakeReq = { bot: { name: 'atlas', role: 'operator' } };
    assert.ok(isOperator(fakeReq), 'operator role must pass');
    const workerReq = { bot: { name: 'forge', role: 'worker', capabilities: ['fs.read'] } };
    assert.equal(isOperator(workerReq), null, 'worker must be refused');
    const anonReq = {};
    assert.equal(isOperator(anonReq), null, 'anon must be refused');
  });

  it('tenant metrics: unknown/disabled tenant → null (anti-enumeration 404)', async () => {
    // Hermetic DB: this test must not depend on the developer checkout's
    // live data/gateway.db (cwd-relative resolution made it pass only where
    // a 'main' tenant already existed — e.g. the VDS repo dir — but fail in
    // the works CI checkout under /tmp, where the DB starts empty).
    // Point TG_DB_FILE at a temp file and create 'main' explicitly.
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDb = path.join(os.tmpdir(), `fnroute-${process.pid}-${Date.now()}.db`);
    process.env.TG_DB_FILE = tmpDb;
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenants')];
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    const { TenantStore } = require('../src/gateway/tenants');
    new TenantStore().ensureMain();
    // chain_entries schema (tenant-metrics reads the audit chain) is created
    // by the Gateway boot normally; in this hermetic DB we must create it.
    const { SqlChain } = require('../src/gateway/sql-chain');
    new SqlChain({ file: tmpDb });
    const tm = require('../src/gateway/tenant-metrics');
    // Enabled fixture tenant from tenants-mount tests may exist; ghost never does
    process.env.TG_TENANT_METRICS = '1';
    const tm2 = require('../src/gateway/tenant-metrics');
    // ghost-tenant is not in the tenants table → null (mount maps to 404)
    assert.equal(tm2.getMetrics('ghost-no-such-tenant'), null);
    // 'main' exists (ensureMain) → non-null structure
    const r = tm2.getMetrics('main');
    assert.ok(r, 'main tenant must resolve');
    assert.equal(r.tenant, 'main');
    delete process.env.TG_TENANT_METRICS;
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    fs.rmSync(tmpDb, { force: true });
  });
});
