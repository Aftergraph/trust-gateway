const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-W4 skill dependencies', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-w4-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILL_DEPS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skill-deps')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const d = require('../src/gateway/skill-deps');
    assert.equal(d.enabled(), true);
  });

  it('valid skill with no requires returns ok', () => {
    const d = require('../src/gateway/skill-deps');
    const r = d.validate({ id: 'skill-a' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.requires, []);
  });

  it('self-reference rejected', () => {
    const d = require('../src/gateway/skill-deps');
    const r = d.validate({ id: 'skill-b', requires: ['skill-b'] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'self_reference');
  });

  it('invalid dependency slug rejected', () => {
    const d = require('../src/gateway/skill-deps');
    const r = d.validate({ id: 'skill-c', requires: ['BAD!SLUG'] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_dependency_slug');
  });

  it('missing dependency (strict) rejected', () => {
    const d = require('../src/gateway/skill-deps');
    // No skills table → strict treats as missing
    const r = d.validate({ id: 'skill-d', requires: ['nonexistent'] }, { strict: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing_dependency');
    assert.equal(r.missing, 'nonexistent');
  });

  it('missing dependency (non-strict) accepted', () => {
    const d = require('../src/gateway/skill-deps');
    const r = d.validate({ id: 'skill-e', requires: ['unknown'] });
    assert.equal(r.ok, true);
  });

  it('cycle detected via DFS', () => {
    const d = require('../src/gateway/skill-deps');
    // Self-cycle via direct requires
    const r1 = d.detectCycle('skill-f', ['skill-f']);
    assert.equal(r1.hasCycle, true);
  });

  it('inert when TG_SKILL_DEPS unset', () => {
    delete process.env.TG_SKILL_DEPS;
    delete require.cache[require.resolve('../src/gateway/skill-deps')];
    const d = require('../src/gateway/skill-deps');
    assert.equal(d.enabled(), false);
    const r = d.validate({ id: 'x', requires: ['x'] });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    process.env.TG_SKILL_DEPS = '1';
    delete require.cache[require.resolve('../src/gateway/skill-deps')];
  });
});
