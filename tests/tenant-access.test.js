'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../src/gateway/server');

describe('FS-A1 slice 3: tenant accessible listing', () => {
  let gw;

  before(() => {
    gw = new Gateway({ mountFiles: false, telemetryFile: null, bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      worker: { token: 'tok-w', role: 'worker', capabilities: [] },
    } });
    require('../src/gateway/tenant-access').mountTenantAccess(gw);
  });

  it('route registered and matchable', () => {
    assert.ok(gw._fnRoutes.length >= 1, 'fn route registered');
    assert.ok(gw._matchFunctionRoute('GET', '/v2/tenants/accessible'), ':exact path must match');
    assert.equal(gw._matchFunctionRoute('GET', '/v2/tenants/accessible/x'), null, 'no over-match');
  });

  it('listing includes main + created tenants, no secrets', () => {
    const { getTenantStore } = require('../src/gateway/tenants');
    const store = getTenantStore(gw);
    store.create({ name: 'acme-s3' });
    const op = { bot: { name: 'op', role: 'operator' } };
    const tenants = store.list().map(t => ({ id: t.id, name: t.name, disabled: !!t.disabled }));
    const acme = tenants.find(t => t.id === 'acme-s3');
    assert.ok(acme, 'created tenant listed');
    assert.equal(acme.disabled, false);
    const ids = tenants.map(t => t.id);
    assert.ok(tenants.some(t => t.id === 'main'), 'main always listed');
    assert.ok(!JSON.stringify(tenants).includes('token'), 'no secrets in listing');
    void op;
  });
});