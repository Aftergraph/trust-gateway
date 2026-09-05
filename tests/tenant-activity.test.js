const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-W1 tenant activity', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-w1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_ACTIVITY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-activity')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const ta = require('../src/gateway/tenant-activity');
    assert.equal(ta.enabled(), true);
  });

  it('touch returns timestamp', () => {
    const ta = require('../src/gateway/tenant-activity');
    const at = ta.touch('acme');
    assert.ok(at > 0);
  });

  it('getActivity returns updated record', () => {
    const ta = require('../src/gateway/tenant-activity');
    ta.touch('beta');
    const r = ta.getActivity('beta');
    assert.ok(r);
    assert.equal(r.tenant, 'beta');
    assert.ok(r.lastActivityAt > 0);
    assert.equal(r.totalOps, 1);
  });

  it('totalOps persists across touches', () => {
    const ta = require('../src/gateway/tenant-activity');
    ta.touch('gamma');
    ta.touch('gamma');
    ta.touch('gamma');
    const r = ta.getActivity('gamma');
    assert.equal(r.totalOps, 3);
  });

  it('getActivity returns null for unknown tenant', () => {
    const ta = require('../src/gateway/tenant-activity');
    assert.equal(ta.getActivity('never-touched'), null);
  });

  it('listInactive filters by threshold', () => {
    const ta = require('../src/gateway/tenant-activity');
    ta.touch('recent');
    // Manually insert an old one
    const { db } = require('../src/gateway/db');
    const old = Date.now() - 1000 * 60 * 60 * 24 * 100; // 100 days ago
    db.prepare(`INSERT OR REPLACE INTO tenant_activity(tenant, last_activity_at, total_ops) VALUES(?, ?, 1)`).run('ancient', old);
    const list = ta.listInactive(30 * 24 * 60 * 60 * 1000); // 30d threshold
    const tenants = list.map(r => r.tenant);
    assert.ok(tenants.includes('ancient'));
    assert.ok(!tenants.includes('recent'));
  });

  it('inert when TG_TENANT_ACTIVITY unset', () => {
    delete process.env.TG_TENANT_ACTIVITY;
    delete require.cache[require.resolve('../src/gateway/tenant-activity')];
    const ta = require('../src/gateway/tenant-activity');
    assert.equal(ta.enabled(), false);
    assert.equal(ta.touch('x'), 0);
    assert.equal(ta.getActivity('x'), null);
    assert.deepEqual(ta.listInactive(), []);
    process.env.TG_TENANT_ACTIVITY = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-activity')];
  });
});
