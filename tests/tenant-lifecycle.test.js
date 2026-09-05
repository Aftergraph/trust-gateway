const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-M1 tenant lifecycle', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-m1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/kvstore')];
    delete require.cache[require.resolve('../src/gateway/tenant-lifecycle')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shouldAutoDisable returns true for already-disabled tenant', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    assert.equal(shouldAutoDisable({ id: 'a', disabled: true }, { diskPct: 50 }, Date.now()), true);
  });

  it('shouldAutoDisable returns false when below threshold', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 50, lastUpdated: now }, now), false);
  });

  it('shouldAutoDisable returns true when over threshold long enough', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    const overSince = now - 2 * 60 * 60 * 1000; // 2h ago, > 1h default
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 98, lastUpdated: overSince }, now), true);
  });

  it('shouldAutoDisable returns false when over threshold but recent', () => {
    const { shouldAutoDisable } = require('../src/gateway/tenant-lifecycle');
    const now = Date.now();
    const overSince = now - 1000; // 1s ago
    assert.equal(shouldAutoDisable({ id: 'a', disabled: false }, { diskPct: 98, lastUpdated: overSince }, now), false);
  });

  it('markAutoDisabled requires reason', () => {
    const { markAutoDisabled } = require('../src/gateway/tenant-lifecycle');
    const r = markAutoDisabled('acme', '', 'op1');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing_reason');
  });

  it('cleanupOrphanedTenants returns empty on fresh DB', () => {
    const { cleanupOrphanedTenants } = require('../src/gateway/tenant-lifecycle');
    const r = cleanupOrphanedTenants();
    assert.deepEqual(r, []);
  });
});
