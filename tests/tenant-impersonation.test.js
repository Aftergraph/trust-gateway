const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-O2 tenant impersonation', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-o2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_IMPERSONATION = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-impersonation')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    assert.equal(imp.enabled(), true);
  });

  it('issue returns token + expiry', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    const r = imp.issue('op1', 'acme', 60000, 'support ticket #42');
    assert.ok(r.token);
    assert.equal(r.token.length, 64);
    assert.equal(r.targetTenant, 'acme');
    assert.equal(r.operator, 'op1');
    assert.ok(r.expiresAt > Date.now());
  });

  it('resolve returns valid impersonation', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    const r = imp.issue('op2', 'beta', 60000);
    const resolved = imp.resolve(r.token);
    assert.equal(resolved.operator, 'op2');
    assert.equal(resolved.tenant, 'beta');
  });

  it('resolve returns null for unknown token', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    assert.equal(imp.resolve('nonexistent'), null);
  });

  it('revoke makes resolve return null', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    const r = imp.issue('op3', 'gamma', 60000);
    assert.equal(imp.revoke(r.token, 'done'), true);
    assert.equal(imp.resolve(r.token), null);
  });

  it('expired token resolves to null', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    const r = imp.issue('op4', 'delta', 1); // 1ms ttl
    // Wait briefly to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 50) {}
    assert.equal(imp.resolve(r.token), null);
  });

  it('listActive returns only non-revoked non-expired', () => {
    const imp = require('../src/gateway/tenant-impersonation');
    imp.issue('op5', 'epsilon', 60000);
    const r = imp.issue('op6', 'zeta', 60000);
    imp.revoke(r.token, 'done');
    const list = imp.listActive();
    const tenants = list.map(t => t.target_tenant);
    assert.ok(tenants.includes('epsilon'));
    assert.ok(!tenants.includes('zeta'));
  });

  it('inert when TG_TENANT_IMPERSONATION unset', () => {
    delete process.env.TG_TENANT_IMPERSONATION;
    delete require.cache[require.resolve('../src/gateway/tenant-impersonation')];
    const imp = require('../src/gateway/tenant-impersonation');
    assert.equal(imp.enabled(), false);
    assert.equal(imp.issue('op', 'x', 1000), null);
    process.env.TG_TENANT_IMPERSONATION = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-impersonation')];
  });
});
