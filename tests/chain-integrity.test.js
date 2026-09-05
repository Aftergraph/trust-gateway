const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Y2 chain integrity', () => {
  let tmpDir;
  let origEnv;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-y2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_CHAIN_INTEGRITY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/chain-integrity')];
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
    const ci = require('../src/gateway/chain-integrity');
    assert.equal(ci.enabled(), true);
  });

  it('verifyFull returns ok on empty chain', () => {
    const ci = require('../src/gateway/chain-integrity');
    const r = ci.verifyFull();
    assert.equal(r.ok, true);
    assert.equal(r.checked, 0);
  });

  it('verifyRange returns ok on empty range', () => {
    const ci = require('../src/gateway/chain-integrity');
    const r = ci.verifyRange(1, 100);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 0);
  });

  it('inert when TG_CHAIN_INTEGRITY unset', () => {
    delete process.env.TG_CHAIN_INTEGRITY;
    delete require.cache[require.resolve('../src/gateway/chain-integrity')];
    const ci = require('../src/gateway/chain-integrity');
    assert.equal(ci.enabled(), false);
    assert.equal(ci.verifyFull(), null);
    process.env.TG_CHAIN_INTEGRITY = '1';
    delete require.cache[require.resolve('../src/gateway/chain-integrity')];
  });
});
