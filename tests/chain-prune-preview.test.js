const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-N3 chain-prune preview', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-n3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_CHAIN_PRUNE_PREVIEW = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/chain-prune-preview')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const p = require('../src/gateway/chain-prune-preview');
    assert.equal(p.enabled(), true);
  });

  it('returns null for invalid beforeTs', () => {
    const p = require('../src/gateway/chain-prune-preview');
    assert.equal(p.preview(NaN), null);
    assert.equal(p.preview('not-a-number'), null);
  });

  it('returns null when no audit_chain table', () => {
    const p = require('../src/gateway/chain-prune-preview');
    const r = p.preview(Date.now() - 86400000);
    // No audit_chain → preview returns null gracefully
    assert.equal(r, null);
  });

  it('inert when TG_CHAIN_PRUNE_PREVIEW unset', () => {
    delete process.env.TG_CHAIN_PRUNE_PREVIEW;
    delete require.cache[require.resolve('../src/gateway/chain-prune-preview')];
    const p = require('../src/gateway/chain-prune-preview');
    assert.equal(p.enabled(), false);
    assert.equal(p.preview(Date.now()), null);
    process.env.TG_CHAIN_PRUNE_PREVIEW = '1';
    delete require.cache[require.resolve('../src/gateway/chain-prune-preview')];
  });
});
