const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-X2 skill sandbox profiles', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-x2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILL_SANDBOX = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skill-sandbox')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const sb = require('../src/gateway/skill-sandbox');
    assert.equal(sb.enabled(), true);
  });

  it('set stores profile', () => {
    const sb = require('../src/gateway/skill-sandbox');
    const r = sb.set('skill-a', { network: 'loopback', fsWrite: true, timeoutMs: 60000, memoryMb: 1024 }, 'op1');
    assert.equal(r.ok, true);
    assert.equal(r.network, 'loopback');
    assert.equal(r.fsWrite, 1); // 1 = true (numeric)
    assert.equal(r.timeoutMs, 60000);
  });

  it('get returns stored profile', () => {
    const sb = require('../src/gateway/skill-sandbox');
    sb.set('skill-b', { network: 'any', fsWrite: false }, 'op1');
    const r = sb.get('skill-b');
    assert.ok(r);
    assert.equal(r.network, 'any');
    assert.equal(r.fsWrite, false);
  });

  it('invalid network falls back to none', () => {
    const sb = require('../src/gateway/skill-sandbox');
    const r = sb.set('skill-c', { network: 'BAD' }, 'op1');
    assert.equal(r.ok, true);
    assert.equal(r.network, 'none');
  });

  it('defaults applied when profile fields missing', () => {
    const sb = require('../src/gateway/skill-sandbox');
    const r = sb.set('skill-d', {}, 'op1');
    assert.equal(r.network, 'none');
    assert.equal(r.fsWrite, 0); // 0 = false (numeric)
    assert.equal(r.timeoutMs, 30000);
    assert.equal(r.memoryMb, 512);
  });

  it('remove deletes profile', () => {
    const sb = require('../src/gateway/skill-sandbox');
    sb.set('skill-e', { network: 'none' }, 'op1');
    assert.equal(sb.remove('skill-e'), true);
    assert.equal(sb.get('skill-e'), null);
  });

  it('list returns all profiles', () => {
    const sb = require('../src/gateway/skill-sandbox');
    sb.set('skill-f', { network: 'loopback' }, 'op1');
    sb.set('skill-g', { network: 'any' }, 'op1');
    const list = sb.list();
    const ids = list.map(p => p.skillId);
    assert.ok(ids.includes('skill-f'));
    assert.ok(ids.includes('skill-g'));
  });

  it('effectiveArgs returns null for unknown skill (use defaults)', () => {
    const sb = require('../src/gateway/skill-sandbox');
    assert.equal(sb.effectiveArgs('never-set'), null);
  });

  it('inert when TG_SKILL_SANDBOX unset', () => {
    delete process.env.TG_SKILL_SANDBOX;
    delete require.cache[require.resolve('../src/gateway/skill-sandbox')];
    const sb = require('../src/gateway/skill-sandbox');
    assert.equal(sb.enabled(), false);
    assert.equal(sb.set('x', {}, 'op'), null);
    assert.equal(sb.get('x'), null);
    assert.deepEqual(sb.list(), []);
    process.env.TG_SKILL_SANDBOX = '1';
    delete require.cache[require.resolve('../src/gateway/skill-sandbox')];
  });
});
