const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-W5 deep healthz', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-w5-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/healthz-deep')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('check returns object with ts + checks', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    assert.ok(r.ts > 0);
    assert.ok(r.checks);
    assert.ok(typeof r.ok === 'boolean');
  });

  it('chain.check fails gracefully when no audit_chain', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    assert.ok(r.checks.chain);
    // In test DB without audit_chain → ok:false with error
    assert.equal(r.checks.chain.ok, false);
    assert.equal(r.checks.chain.error, 'no_audit_chain');
  });

  it('db.check succeeds', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    assert.equal(r.checks.db.ok, true);
  });

  it('disk.check reports usage', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    assert.ok(r.checks.disk);
    assert.equal(typeof r.checks.disk.usedPct, 'number');
    assert.equal(typeof r.checks.disk.freeMb, 'number');
    assert.equal(typeof r.checks.disk.totalMb, 'number');
  });

  it('gateway.check reports uptime + memory', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    assert.equal(r.checks.gateway.ok, true);
    assert.ok(r.checks.gateway.uptimeSec >= 0);
    assert.ok(r.checks.gateway.rssMb > 0);
  });

  it('overall ok=false when chain is unhealthy', () => {
    const { check } = require('../src/gateway/healthz-deep');
    const r = check();
    // chain is unhealthy (no_audit_chain) → overall ok=false
    assert.equal(r.ok, false);
  });
});
