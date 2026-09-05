const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z2 federation audit dashboard', () => {
  let tmpDir;
  let origEnv;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_FED_AUDIT_DASH = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/fed-audit-dash')];
    db = require('../src/gateway/db').db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS chain_entries (
        seq INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      )
    `);
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const fed = require('../src/gateway/fed-audit-dash');
    assert.equal(fed.enabled(), true);
  });

  it('query returns structure on empty chain', () => {
    const fed = require('../src/gateway/fed-audit-dash');
    const r = fed.query({});
    assert.equal(r.total, 0);
    assert.ok(Array.isArray(r.events));
    assert.equal(r.limit, 50);
    assert.equal(r.offset, 0);
  });

  it('summary returns structure on empty chain', () => {
    const fed = require('../src/gateway/fed-audit-dash');
    const r = fed.summary();
    assert.equal(r.totalEvents, 0);
    assert.ok(Array.isArray(r.byType));
    assert.ok(Array.isArray(r.byTenant));
  });

  it('query with filters returns structure', () => {
    const fed = require('../src/gateway/fed-audit-dash');
    const r = fed.query({ type: 'login', tenant: 'acme', limit: 10, offset: 5 });
    assert.equal(r.limit, 10);
    assert.equal(r.offset, 5);
    assert.ok(Array.isArray(r.events));
  });

  it('inert when TG_FED_AUDIT_DASH unset', () => {
    delete process.env.TG_FED_AUDIT_DASH;
    delete require.cache[require.resolve('../src/gateway/fed-audit-dash')];
    const fed = require('../src/gateway/fed-audit-dash');
    assert.equal(fed.enabled(), false);
    assert.equal(fed.query({}), null);
    assert.equal(fed.summary(), null);
    process.env.TG_FED_AUDIT_DASH = '1';
    delete require.cache[require.resolve('../src/gateway/fed-audit-dash')];
  });
});
