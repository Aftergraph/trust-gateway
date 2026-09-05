const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-K4 quota usage alerts', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-k4-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/kvstore')];
    delete require.cache[require.resolve('../src/gateway/quota-alerts')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evaluates disk warning at 80% threshold', () => {
    const { evaluateTenant } = require('../src/gateway/quota-alerts');
    const r = evaluateTenant('acme', 85, 100, 0, 1000);
    assert.ok(r.disk);
    assert.equal(r.disk.pct, 85);
    assert.equal(r.disk.tenant, 'acme');
    assert.equal(r.api, null);
  });

  it('evaluates api warning at 80% threshold', () => {
    const { evaluateTenant } = require('../src/gateway/quota-alerts');
    const r = evaluateTenant('acme', 0, 1000, 900, 1000);
    assert.equal(r.disk, null);
    assert.ok(r.api);
    assert.equal(r.api.pct, 90);
  });

  it('below threshold does not fire', () => {
    const { evaluateTenant } = require('../src/gateway/quota-alerts');
    const r = evaluateTenant('acme', 50, 100, 500, 1000);
    assert.equal(r.disk, null);
    assert.equal(r.api, null);
  });

  it('per-tenant rate-limit via shouldEmit', () => {
    const { shouldEmit } = require('../src/gateway/quota-alerts');
    const now = Date.now();
    assert.equal(shouldEmit('acme', 'quota_disk_warning', now), true);
    assert.equal(shouldEmit('acme', 'quota_disk_warning', now), false);
    assert.equal(shouldEmit('beta', 'quota_disk_warning', now), true); // different tenant
  });

  it('checkTenant returns alerts when over threshold', () => {
    const { checkTenant } = require('../src/gateway/quota-alerts');
    const now = Date.now();
    const alerts = checkTenant('gamma', 90, 100, 950, 1000, now);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].type, 'quota_disk_warning');
    assert.equal(alerts[1].type, 'quota_api_warning');
  });

  it('env threshold configurable', () => {
    process.env.TG_QUOTA_DISK_WARN_PCT = '50';
    delete require.cache[require.resolve('../src/gateway/quota-alerts')];
    const { diskWarnPct, evaluateTenant } = require('../src/gateway/quota-alerts');
    assert.equal(diskWarnPct(), 50);
    const r = evaluateTenant('acme', 60, 100, 0, 1000);
    assert.ok(r.disk); // 60% > 50% threshold
    delete process.env.TG_QUOTA_DISK_WARN_PCT;
    delete require.cache[require.resolve('../src/gateway/quota-alerts')];
  });

  it('recentAlerts returns empty when no audit chain', () => {
    const { recentAlerts } = require('../src/gateway/quota-alerts');
    // No audit_chain table in test DB → returns []
    const r = recentAlerts('nonexistent');
    assert.deepEqual(r, []);
  });
});
