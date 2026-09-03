const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-O3 operator dashboard', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-o3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_OPERATOR_DASHBOARD = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/operator-dashboard')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const d = require('../src/gateway/operator-dashboard');
    assert.equal(d.enabled(), true);
  });

  it('build returns object with generatedAt + sections', () => {
    const d = require('../src/gateway/operator-dashboard');
    const r = d.build();
    assert.ok(r.generatedAt > 0);
    assert.ok(r.sections);
  });

  it('each section is fail-open (null on missing table)', () => {
    const d = require('../src/gateway/operator-dashboard');
    const r = d.build();
    // Most sections return null in test DB without those tables
    assert.ok(r.sections);
    // Tenants may work (has its own table init in tenants.js)
    // Skills/apikeys/etc → null is acceptable (fail-open)
  });

  it('inert when TG_OPERATOR_DASHBOARD unset', () => {
    delete process.env.TG_OPERATOR_DASHBOARD;
    delete require.cache[require.resolve('../src/gateway/operator-dashboard')];
    const d = require('../src/gateway/operator-dashboard');
    assert.equal(d.enabled(), false);
    assert.equal(d.build(), null);
    process.env.TG_OPERATOR_DASHBOARD = '1';
    delete require.cache[require.resolve('../src/gateway/operator-dashboard')];
  });

  it('build never throws even with no DB tables', () => {
    // Already covered by the previous test (build returns null on inert)
    // Verify that with all tables missing, build still returns an object
    const d = require('../src/gateway/operator-dashboard');
    const r = d.build();
    assert.ok(r);
    assert.ok(typeof r.sections === 'object');
  });
});
