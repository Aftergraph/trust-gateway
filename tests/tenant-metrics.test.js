const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z1 tenant metrics aggregates', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.enabled(), true);
  });

  it('getMetrics returns null when disabled', () => {
    delete process.env.TG_TENANT_METRICS;
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.getMetrics('acme'), null);
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
  });

  it('getMetrics returns structure on empty chain', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getMetrics('acme');
    assert.equal(r.tenant, 'acme');
    assert.equal(r.totalEvents, 0);
    assert.ok(Array.isArray(r.byType));
    assert.equal(r.lastActivityAt, null);
  });

  it('getAllTenantsSummary returns structure', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getAllTenantsSummary();
    assert.ok(r.tenantCount >= 0);
    assert.ok(Array.isArray(r.tenants));
  });

  it('getMetrics with custom window', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getMetrics('acme', 7200000);
    assert.equal(r.windowMs, 7200000);
  });

  it('inert when TG_TENANT_METRICS unset', () => {
    delete process.env.TG_TENANT_METRICS;
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.enabled(), false);
    assert.equal(tm.getAllTenantsSummary(), null);
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
  });
});
