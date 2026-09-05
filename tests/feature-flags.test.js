const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-L3 persistent feature flags', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-l3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get returns env default when no DB row', () => {
    process.env.TG_FEATURE_FOO_ENABLED = '1';
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
    const flags = require('../src/gateway/feature-flags');
    const r = flags.get('foo');
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'env');
    delete process.env.TG_FEATURE_FOO_ENABLED;
  });

  it('get returns null when no env and no row', () => {
    delete process.env.TG_FEATURE_BAR_ENABLED;
    const flags = require('../src/gateway/feature-flags');
    assert.equal(flags.get('bar'), null);
  });

  it('set overrides env default', () => {
    process.env.TG_FEATURE_BAZ_ENABLED = '0';
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
    const flags = require('../src/gateway/feature-flags');
    const r = flags.set('baz', { enabled: true, value: 'on' }, 'op1');
    assert.equal(r.source, 'db');
    const got = flags.get('baz');
    assert.equal(got.enabled, true);
    assert.equal(got.value, 'on');
    delete process.env.TG_FEATURE_BAZ_ENABLED;
  });

  it('reset reverts to env', () => {
    process.env.TG_FEATURE_QUX_ENABLED = '1';
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
    const flags = require('../src/gateway/feature-flags');
    flags.set('qux', { enabled: false, value: 'off' }, 'op1');
    assert.equal(flags.get('qux').enabled, false);
    assert.equal(flags.reset('qux'), true);
    assert.equal(flags.get('qux').enabled, true); // back to env
    delete process.env.TG_FEATURE_QUX_ENABLED;
  });

  it('list merges env and db sources', () => {
    process.env.TG_FEATURE_ENV_ONLY_ENABLED = '1';
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
    const flags = require('../src/gateway/feature-flags');
    flags.set('db_only', { enabled: true, value: 'x' }, 'op');
    const all = flags.list();
    // Env flag name is uppercased: TG_FEATURE_ENV_ONLY_ENABLED → 'ENV_ONLY'
    const env = all.find(f => f.name === 'ENV_ONLY');
    const db = all.find(f => f.name === 'db_only');
    assert.ok(env, 'env-only flag missing from list');
    assert.equal(env.source, 'env');
    assert.ok(db, 'db-only flag missing from list');
    assert.equal(db.source, 'db');
    delete process.env.TG_FEATURE_ENV_ONLY_ENABLED;
  });

  it('value coercion: number', () => {
    const flags = require('../src/gateway/feature-flags');
    flags.set('num_flag', { enabled: true, value: '42' }, 'op');
    const r = flags.get('num_flag');
    assert.equal(r.value, 42);
  });

  it('value coercion: boolean', () => {
    const flags = require('../src/gateway/feature-flags');
    flags.set('bool_flag', { enabled: true, value: 'true' }, 'op');
    const r = flags.get('bool_flag');
    assert.equal(r.value, true);
  });

  it('persistence across calls', () => {
    const flags = require('../src/gateway/feature-flags');
    flags.set('persist', { enabled: true, value: 'kept' }, 'op');
    delete require.cache[require.resolve('../src/gateway/feature-flags')];
    const flags2 = require('../src/gateway/feature-flags');
    const r = flags2.get('persist');
    assert.equal(r.value, 'kept');
    assert.equal(r.source, 'db');
  });
});
