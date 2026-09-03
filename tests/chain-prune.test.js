const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-W2 chain prune', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-w2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_CHAIN_PRUNE = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/chain-prune')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const { enabled } = require('../src/gateway/chain-prune');
    assert.equal(enabled(), true);
  });

  it('refuses when no audit_chain table (no_audit_chain)', () => {
    const { prune } = require('../src/gateway/chain-prune');
    const r = prune(Date.now() - 86400000);
    assert.equal(r.ok, false);
    // Without audit_chain table → no_audit_chain; with table but small → below_safety_threshold
    assert.ok(['no_audit_chain', 'below_safety_threshold'].includes(r.error));
  });

  it('refuses invalid beforeTs', () => {
    const { prune } = require('../src/gateway/chain-prune');
    assert.equal(prune(NaN).error, 'invalid_before');
    assert.equal(prune('not-a-number').error, 'invalid_before');
  });

  it('force=true bypasses safety (no-op on empty DB)', () => {
    const { prune } = require('../src/gateway/chain-prune');
    const r = prune(Date.now() - 86400000, { force: true, by: 'op' });
    // No audit_chain table → no_audit_chain
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_audit_chain');
  });

  it('inert when TG_CHAIN_PRUNE unset', () => {
    delete process.env.TG_CHAIN_PRUNE;
    delete require.cache[require.resolve('../src/gateway/chain-prune')];
    const { enabled, prune } = require('../src/gateway/chain-prune');
    assert.equal(enabled(), false);
    const r = prune(Date.now());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'prune_disabled');
    process.env.TG_CHAIN_PRUNE = '1';
    delete require.cache[require.resolve('../src/gateway/chain-prune')];
  });
});
