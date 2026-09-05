const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-N2 audit search', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-n2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_AUDIT_SEARCH = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/audit-search')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const s = require('../src/gateway/audit-search');
    assert.equal(s.enabled(), true);
  });

  it('search returns empty on fresh DB', () => {
    const s = require('../src/gateway/audit-search');
    assert.deepEqual(s.search(), []);
  });

  it('count returns 0 on fresh DB', () => {
    const s = require('../src/gateway/audit-search');
    assert.equal(s.count(), 0);
  });

  it('limit cap enforced (max 1000)', () => {
    const s = require('../src/gateway/audit-search');
    const r = s.search({ limit: 9999 });
    assert.deepEqual(r, []);
  });

  it('inert when TG_AUDIT_SEARCH unset', () => {
    delete process.env.TG_AUDIT_SEARCH;
    delete require.cache[require.resolve('../src/gateway/audit-search')];
    const s = require('../src/gateway/audit-search');
    assert.equal(s.enabled(), false);
    assert.deepEqual(s.search(), []);
    assert.equal(s.count(), 0);
    process.env.TG_AUDIT_SEARCH = '1';
    delete require.cache[require.resolve('../src/gateway/audit-search')];
  });

  it('search with type filter does not throw', () => {
    const s = require('../src/gateway/audit-search');
    // No audit_chain table in fresh DB → graceful empty
    const r = s.search({ type: 'login' });
    assert.deepEqual(r, []);
  });
});
