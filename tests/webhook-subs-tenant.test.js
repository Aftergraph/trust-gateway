const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Y1 per-tenant webhook subscriptions', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-y1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_WEBHOOK_SUBS_TENANT = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/webhook-subs-tenant')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    assert.equal(subs.enabled(), true);
  });

  it('create stores with tenant', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    const r = subs.create('acme', 'https://example.com/hook', ['login'], 'op1');
    assert.ok(r.id > 0);
    assert.equal(r.tenant, 'acme');
  });

  it('listForTenant filters by tenant', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    delete require.cache[require.resolve('../src/gateway/webhook-subs-tenant')];
    const s2 = require('../src/gateway/webhook-subs-tenant');
    s2.create('beta', 'https://b.com/h', ['x'], 'op1');
    const all = s2.listForTenant('beta');
    assert.ok(all.length >= 1, `expected at least 1 row, got ${all.length}`);
    // All rows for 'beta' query are either tenant='beta' or tenant='*'
    const tenants = all.map(r => r.tenant);
    for (const t of tenants) {
      assert.ok(t === 'beta' || t === '*', `unexpected tenant ${t} in beta list`);
    }
    // At least one row must be specifically 'beta' (the one we just created)
    assert.ok(tenants.includes('beta'));
  });

  it('listForTenant includes * subs (wildcard)', () => {
    delete require.cache[require.resolve('../src/gateway/webhook-subs-tenant')];
    const s2 = require('../src/gateway/webhook-subs-tenant');
    s2.create('*', 'https://all.com/h', ['any'], 'op1');
    const all = s2.listForTenant('gamma');
    assert.ok(all.some(r => r.tenant === '*'));
  });

  it('invalid url refused', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    assert.throws(() => subs.create('acme', 'not-a-url', ['x'], 'op'), /invalid_input/);
  });

  it('empty event types refused', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    assert.throws(() => subs.create('acme', 'https://x.com', [], 'op'), /invalid_event_types/);
  });

  it('recordDelivery updates lastDeliveredAt', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    const r = subs.create('delta', 'https://d.com', ['x'], 'op1');
    subs.recordDelivery(r.id, true);
    const all = subs.listForTenant('delta');
    const updated = all.find(x => x.id === r.id);
    assert.ok(updated.lastDeliveredAt > 0);
  });

  it('listAll returns all tenants', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    subs.create('e1', 'https://e1.com', ['x'], 'op');
    subs.create('e2', 'https://e2.com', ['y'], 'op');
    const all = subs.listAll();
    const tenants = new Set(all.map(r => r.tenant));
    assert.ok(tenants.has('e1'));
    assert.ok(tenants.has('e2'));
  });

  it('remove deletes by id+tenant', () => {
    const subs = require('../src/gateway/webhook-subs-tenant');
    const r = subs.create('zeta', 'https://z.com', ['x'], 'op');
    assert.equal(subs.remove('zeta', r.id), true);
    assert.equal(subs.remove('zeta', r.id), false);
  });

  it('inert when TG_WEBHOOK_SUBS_TENANT unset', () => {
    delete process.env.TG_WEBHOOK_SUBS_TENANT;
    delete require.cache[require.resolve('../src/gateway/webhook-subs-tenant')];
    const subs = require('../src/gateway/webhook-subs-tenant');
    assert.equal(subs.enabled(), false);
    assert.equal(subs.create('a', 'https://x.com', ['x'], 'op'), null);
    assert.deepEqual(subs.listAll(), []);
    process.env.TG_WEBHOOK_SUBS_TENANT = '1';
    delete require.cache[require.resolve('../src/gateway/webhook-subs-tenant')];
  });
});
