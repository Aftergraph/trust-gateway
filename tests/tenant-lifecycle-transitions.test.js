const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function resetModules() {
  for (const m of [
    '../src/gateway/db',
    '../src/gateway/kvstore',
    '../src/gateway/tenant-lifecycle',
    '../src/gateway/tenant-lifecycle-store',
    '../src/gateway/mounts/161-tenant-lifecycle-transitions',
  ]) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
  }
}

// Minimal fake for function-style mounts: captures handlers, drives them
// with a mock req/res pair.
function fakeGw() {
  const routes = {};
  return {
    routes,
    router: {
      get(p, h) { routes['GET ' + p] = h; },
      post(p, h) { routes['POST ' + p] = h; },
    },
  };
}

function drive(handler, { url, body, operator = true }) {
  return new Promise((resolve) => {
    const req = {
      url,
      __tgOperator: operator,
      bot: operator ? { name: 'op-test' } : { name: 'anon' },
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(typeof body === 'string' ? body : JSON.stringify(body));
        if (ev === 'end') cb();
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload || '{}') }); },
    };
    handler(req, res);
  });
}

describe('TG85 tenant lifecycle record store', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg85-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    resetModules();
  });

  after(() => {
    process.env = origEnv;
    resetModules();
    try { require('../src/gateway/db').closeDb(); } catch { /* unopened */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getRecord returns null when no record exists (fail-closed)', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    assert.equal(store.getRecord('ghost-tenant'), null);
  });

  it('createRecord rejects empty required_owners and persists nothing', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    const r = store.createRecord('t1', { requiredOwners: [], actor: 'op' });
    assert.equal(r.ok, false);
    assert.equal(store.getRecord('t1'), null);
  });

  it('createRecord opens an active 0.1 record; second open conflicts', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    const r = store.createRecord('t2', { requiredOwners: ['jonas'], actor: 'op' });
    assert.equal(r.ok, true);
    assert.equal(r.record.schema, 'tenant-lifecycle/0.1');
    assert.equal(r.record.state, 'active');
    assert.equal(r.record.tenant_id, 't2');
    const again = store.createRecord('t2', { requiredOwners: ['jonas'], actor: 'op' });
    assert.equal(again.ok, false);
    assert.equal(again.error, 'record_exists');
  });

  it('applyTransition persists allowed moves and refuses illegal ones unchanged', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    store.createRecord('t3', { requiredOwners: ['jonas'], actor: 'op' });
    const ok = store.applyTransition('t3', 'suspended', 'op');
    assert.equal(ok.ok, true);
    assert.equal(ok.record.state, 'suspended');
    assert.equal(ok.record.previous_state, 'active');
    const bad = store.applyTransition('t3', 'deleted', 'op');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'illegal_transition');
    assert.equal(store.getRecord('t3').state, 'suspended');
  });

  it('deleting->deleted requires every owner ack, then allows', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    store.createRecord('t4', { requiredOwners: ['a', 'b'], actor: 'op' });
    store.applyTransition('t4', 'deleting', 'op');
    const early = store.applyTransition('t4', 'deleted', 'op');
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'missing_owner_acks');
    assert.equal(store.recordAck('t4', { owner: 'a', ack: 'deletion' }).ok, true);
    assert.equal(store.applyTransition('t4', 'deleted', 'op').ok, false);
    assert.equal(store.recordAck('t4', { owner: 'b', ack: 'deletion' }).ok, true);
    const done = store.applyTransition('t4', 'deleted', 'op');
    assert.equal(done.ok, true);
    assert.equal(done.record.state, 'deleted');
  });

  it('recordAck rejects bad kinds and unknown owners', () => {
    const store = require('../src/gateway/tenant-lifecycle-store');
    store.createRecord('t5', { requiredOwners: ['a'], actor: 'op' });
    assert.equal(store.recordAck('t5', { owner: 'a', ack: 'nuke' }).ok, false);
    assert.equal(store.recordAck('t5', { owner: 'stranger', ack: 'export' }).ok, false);
    assert.equal(store.getRecord('t5').owner_acknowledgements.length, 0);
  });
});

describe('TG85 tenant lifecycle transition endpoints (operator-only)', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg85m-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    resetModules();
  });

  after(() => {
    process.env = origEnv;
    resetModules();
    try { require('../src/gateway/db').closeDb(); } catch { /* unopened */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-operator gets 403 on every route', async () => {
    const gw = fakeGw();
    require('../src/gateway/mounts/161-tenant-lifecycle-transitions')(gw);
    for (const key of Object.keys(gw.routes)) {
      const r = await drive(gw.routes[key], { url: '/x', body: {}, operator: false });
      assert.equal(r.status, 403, key);
      assert.equal(r.body.error, 'operator_required');
    }
  });

  it('open -> get -> transition -> denied transition keeps prior state', async () => {
    const gw = fakeGw();
    require('../src/gateway/mounts/161-tenant-lifecycle-transitions')(gw);
    const open = await drive(gw.routes['POST /v2/tenants/:id/lifecycle/open'],
      { url: '/v2/tenants/acme/lifecycle/open', body: { required_owners: ['jonas'] } });
    assert.equal(open.status, 200);
    const get = await drive(gw.routes['GET /v2/tenants/:id/lifecycle'],
      { url: '/v2/tenants/acme/lifecycle', body: undefined });
    assert.equal(get.body.state, 'active');
    const go = await drive(gw.routes['POST /v2/tenants/:id/lifecycle/transition'],
      { url: '/v2/tenants/acme/lifecycle/transition', body: { to_state: 'suspended' } });
    assert.equal(go.status, 200);
    assert.equal(go.body.record.state, 'suspended');
    const denied = await drive(gw.routes['POST /v2/tenants/:id/lifecycle/transition'],
      { url: '/v2/tenants/acme/lifecycle/transition', body: { to_state: 'deleted' } });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.reason, 'illegal_transition');
    const still = await drive(gw.routes['GET /v2/tenants/:id/lifecycle'],
      { url: '/v2/tenants/acme/lifecycle', body: undefined });
    assert.equal(still.body.state, 'suspended');
  });

  it('get on unknown tenant is 404, open with bad owners is 400', async () => {
    const gw = fakeGw();
    require('../src/gateway/mounts/161-tenant-lifecycle-transitions')(gw);
    const missing = await drive(gw.routes['GET /v2/tenants/:id/lifecycle'],
      { url: '/v2/tenants/nobody/lifecycle', body: undefined });
    assert.equal(missing.status, 404);
    const bad = await drive(gw.routes['POST /v2/tenants/:id/lifecycle/open'],
      { url: '/v2/tenants/nobody/lifecycle/open', body: { required_owners: [] } });
    assert.equal(bad.status, 400);
  });
});
