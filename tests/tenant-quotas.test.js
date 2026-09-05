const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z6 tenant quota enforcement', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z6-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_QUOTAS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-resource-quotas')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const tq = require('../src/gateway/tenant-resource-quotas');
    assert.equal(tq.enabled(), true);
  });

  it('setQuota stores and getQuota retrieves', () => {
    const tq = require('../src/gateway/tenant-resource-quotas');
    tq.setQuota('acme', 'api_calls', 1000);
    const q = tq.getQuota('acme', 'api_calls');
    assert.equal(q.maxValue, 1000);
  });

  it('checkAndIncrement allows under quota', () => {
    const tq = require('../src/gateway/tenant-resource-quotas');
    tq.setQuota('beta', 'api_calls', 5);
    const r = tq.checkAndIncrement('beta', 'api_calls', 3);
    assert.equal(r.allowed, true);
    assert.equal(r.used, 3);
  });

  it('checkAndIncrement denies over quota', () => {
    const tq = require('../src/gateway/tenant-resource-quotas');
    tq.setQuota('gamma', 'api_calls', 2);
    tq.checkAndIncrement('gamma', 'api_calls', 2);
    const r = tq.checkAndIncrement('gamma', 'api_calls', 1);
    assert.equal(r.allowed, false);
  });

  it('getUsage returns structure', () => {
    const tq = require('../src/gateway/tenant-resource-quotas');
    const u = tq.getUsage('delta', 'storage');
    assert.equal(u.tenant, 'delta');
    assert.equal(u.used, 0);
  });

  it('inert when TG_TENANT_QUOTAS unset', () => {
    delete process.env.TG_TENANT_QUOTAS;
    delete require.cache[require.resolve('../src/gateway/tenant-resource-quotas')];
    const tq = require('../src/gateway/tenant-resource-quotas');
    assert.equal(tq.enabled(), false);
    assert.equal(tq.setQuota('x', 'y', 1), null);
    assert.deepEqual(tq.checkAndIncrement('x', 'y', 1), { allowed: true, quotaDisabled: true });
    process.env.TG_TENANT_QUOTAS = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-resource-quotas')];
  });
});
