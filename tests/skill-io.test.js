const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-O1 skill import/export', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-o1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILL_IO = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skill-io')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const io = require('../src/gateway/skill-io');
    assert.equal(io.enabled(), true);
  });

  it('exportSkill returns null for missing skill', () => {
    const io = require('../src/gateway/skill-io');
    // No skills table in fresh test DB → returns null gracefully
    assert.equal(io.exportSkill('nonexistent'), null);
  });

  it('exportSkill returns null when no skills table', () => {
    const io = require('../src/gateway/skill-io');
    // Verified by the previous test — no skills table → null
    assert.equal(io.exportSkill('whatever'), null);
  });

  it('importSkill rejects invalid format', () => {
    const io = require('../src/gateway/skill-io');
    const r = io.importSkill({ format: 'wrong', skill: {} }, 'op');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_format');
  });

  it('importSkill rejects invalid skill payload', () => {
    const io = require('../src/gateway/skill-io');
    const r = io.importSkill({ format: io.FORMAT, skill: {} }, 'op');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_skill');
  });

  it('exportAll returns object with format', () => {
    const io = require('../src/gateway/skill-io');
    const r = io.exportAll();
    assert.equal(r.format, io.FORMAT);
    assert.ok(Array.isArray(r.skills));
  });

  it('importBulk returns counts', () => {
    const io = require('../src/gateway/skill-io');
    const r = io.importBulk([], 'op');
    assert.equal(r.ok, 0);
    assert.equal(r.failed, 0);
  });

  it('inert when TG_SKILL_IO unset', () => {
    delete process.env.TG_SKILL_IO;
    delete require.cache[require.resolve('../src/gateway/skill-io')];
    const io = require('../src/gateway/skill-io');
    assert.equal(io.enabled(), false);
    assert.equal(io.exportSkill('x'), null);
    assert.equal(io.exportAll(), null);
    process.env.TG_SKILL_IO = '1';
    delete require.cache[require.resolve('../src/gateway/skill-io')];
  });
});
