const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Y2 chain integrity', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-y2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_CHAIN_INTEGRITY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/chain-integrity')];
  });

  after(() => {
    process.env = origEnv;
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
