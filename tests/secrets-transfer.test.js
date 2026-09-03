const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-L1 tenant-to-tenant secret transfer', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-l1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SECRETS_VAULT = '1';
    process.env.TG_SECRETS_MASTER_KEY = 'a'.repeat(32);
    // Clear module cache so db.js + secrets-vault pick up temp DB + env
    for (const m of ['../src/gateway/db', '../src/gateway/kvstore', '../src/gateway/secrets-vault', '../src/gateway/secrets-transfer']) {
      try { delete require.cache[require.resolve(m)]; } catch {}
    }
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects TG_SECRETS_VAULT=1', () => {
    const { enabled } = require('../src/gateway/secrets-transfer');
    assert.equal(enabled(), true);
  });

  it('happy path: transfer moves plaintext from source to dest', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    const { SecretsVault } = require('../src/gateway/secrets-vault');
    const v = new SecretsVault();
    v.setSecret('acme', 'api_token', 'super-secret-value-123');
    const r = transferSecret({
      fromTenant: 'acme', toTenant: 'beta', key: 'api_token', reason: 'tenant migration', by: 'op1',
    });
    assert.equal(r.key, 'api_token');
    assert.equal(v.getSecret('acme', 'api_token'), null);
    assert.equal(v.getSecret('beta', 'api_token'), 'super-secret-value-123');
  });

  it('same-tenant transfer refused', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    const { SecretsVault } = require('../src/gateway/secrets-vault');
    const v = new SecretsVault();
    v.setSecret('acme', 'k1', 'v1');
    assert.throws(() => transferSecret({
      fromTenant: 'acme', toTenant: 'acme', key: 'k1', reason: 'r', by: 'op',
    }), /same_tenant/);
  });

  it('source missing refused', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    assert.throws(() => transferSecret({
      fromTenant: 'acme', toTenant: 'beta', key: 'nonexistent', reason: 'r', by: 'op',
    }), /source_missing/);
  });

  it('dest already has key refused', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    const { SecretsVault } = require('../src/gateway/secrets-vault');
    const v = new SecretsVault();
    v.setSecret('acme', 'k2', 'src-value');
    v.setSecret('beta', 'k2', 'dest-existing');
    assert.throws(() => transferSecret({
      fromTenant: 'acme', toTenant: 'beta', key: 'k2', reason: 'r', by: 'op',
    }), /dest_conflict/);
  });

  it('missing reason refused', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    const { SecretsVault } = require('../src/gateway/secrets-vault');
    const v = new SecretsVault();
    v.setSecret('acme', 'k3', 'v');
    assert.throws(() => transferSecret({
      fromTenant: 'acme', toTenant: 'beta', key: 'k3', reason: '', by: 'op',
    }), /missing_reason/);
  });

  it('invalid key slug refused', () => {
    const { transferSecret } = require('../src/gateway/secrets-transfer');
    assert.throws(() => transferSecret({
      fromTenant: 'acme', toTenant: 'beta', key: 'BAD KEY!', reason: 'r', by: 'op',
    }), /invalid_key/);
  });

  it('inert when TG_SECRETS_VAULT unset', () => {
    const saved = process.env.TG_SECRETS_VAULT;
    delete process.env.TG_SECRETS_VAULT;
    delete require.cache[require.resolve('../src/gateway/secrets-vault')];
    delete require.cache[require.resolve('../src/gateway/secrets-transfer')];
    const { transferSecret, enabled } = require('../src/gateway/secrets-transfer');
    assert.equal(enabled(), false);
    assert.throws(() => transferSecret({
      fromTenant: 'a', toTenant: 'b', key: 'k', reason: 'r', by: 'op',
    }), /transfer_disabled/);
    process.env.TG_SECRETS_VAULT = saved;
    delete require.cache[require.resolve('../src/gateway/secrets-vault')];
    delete require.cache[require.resolve('../src/gateway/secrets-transfer')];
  });
});
