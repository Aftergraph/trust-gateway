const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-N1 tenant-scoped feature flags', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-n1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_FLAGS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/feature-flags-tenant')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get returns env default when no override', () => {
    process.env.TG_FEATURE_FOO_ENABLED = '1';
    delete require.cache[require.resolve('../src/gateway/feature-flags-tenant')];
    const tf = require('../src/gateway/feature-flags-tenant');
    const r = tf.get('foo', 'acme');
    assert.equal(r.source, 'env');
    assert.equal(r.enabled, true);
    delete process.env.TG_FEATURE_FOO_ENABLED;
  });

  it('tenant override beats global', () => {
    const tf = require('../src/gateway/feature-flags-tenant');
    tf.set('bar', { enabled: false, value: 'global' }, 'op1');
    tf.set('bar', { enabled: true, value: 'tenant' }, 'op1', 'acme');
    const r = tf.get('bar', 'acme');
    assert.equal(r.source, 'tenant');
    assert.equal(r.value, 'tenant');
    const r2 = tf.get('bar', 'beta');
    assert.equal(r2.source, 'global');
    assert.equal(r2.value, 'global');
  });

  it('reset tenant reverts to global', () => {
    const tf = require('../src/gateway/feature-flags-tenant');
    tf.set('baz', { enabled: false, value: 'global' }, 'op1'); // global first
    tf.set('baz', { enabled: true, value: 'tenant' }, 'op1', 'acme');
    assert.equal(tf.reset('baz', 'acme'), true);
    const r = tf.get('baz', 'acme');
    assert.equal(r.source, 'global');
    assert.equal(r.value, 'global');
  });

  it('listForTenant returns tenant + global', () => {
    const tf = require('../src/gateway/feature-flags-tenant');
    tf.set('g1', { enabled: true, value: 'gv' }, 'op1');
    tf.set('t1', { enabled: true, value: 'tv' }, 'op1', 'gamma');
    const list = tf.listForTenant('gamma');
    const names = list.map(r => r.name);
    assert.ok(names.includes('g1'));
    assert.ok(names.includes('t1'));
  });

  it('coerces value to number', () => {
    const tf = require('../src/gateway/feature-flags-tenant');
    tf.set('num', { enabled: true, value: '42' }, 'op1');
    assert.equal(tf.get('num').value, 42);
  });

  it('inert when TG_TENANT_FLAGS unset', () => {
    delete process.env.TG_TENANT_FLAGS;
    delete require.cache[require.resolve('../src/gateway/feature-flags-tenant')];
    const tf = require('../src/gateway/feature-flags-tenant');
    assert.equal(tf.enabled(), false);
    assert.deepEqual(tf.listForTenant('any'), []);
    process.env.TG_TENANT_FLAGS = '1';
    delete require.cache[require.resolve('../src/gateway/feature-flags-tenant')];
  });
});
