const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-M2 skill versions', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-m2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILL_VERSIONS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skill-versions')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('snapshot creates version 1', () => {
    const v = require('../src/gateway/skill-versions');
    const r = v.snapshot('skill-a', [{ kind: 'shell', cmd: 'echo 1' }], 'op1');
    assert.equal(r.version, 1);
    assert.ok(r.id > 0);
  });

  it('second snapshot creates version 2', () => {
    const v = require('../src/gateway/skill-versions');
    v.snapshot('skill-a', [{ kind: 'shell', cmd: 'echo 2' }], 'op1');
    const r = v.snapshot('skill-a', [{ kind: 'shell', cmd: 'echo 3' }], 'op1');
    assert.equal(r.version, 3);
  });

  it('getVersion returns steps', () => {
    const v = require('../src/gateway/skill-versions');
    const got = v.getVersion('skill-a', 1);
    assert.equal(got.version, 1);
    assert.deepEqual(got.steps, [{ kind: 'shell', cmd: 'echo 1' }]);
  });

  it('listVersions returns desc-ordered', () => {
    const v = require('../src/gateway/skill-versions');
    const list = v.listVersions('skill-a');
    assert.ok(list.length >= 3);
    assert.equal(list[0].version, 3);
    assert.equal(list[1].version, 2);
    assert.equal(list[2].version, 1);
  });

  it('rollbackTo returns version steps', () => {
    const v = require('../src/gateway/skill-versions');
    const r = v.rollbackTo('skill-a', 1);
    assert.ok(r);
    assert.deepEqual(r.steps, [{ kind: 'shell', cmd: 'echo 1' }]);
  });

  it('inert when TG_SKILL_VERSIONS unset', () => {
    delete process.env.TG_SKILL_VERSIONS;
    delete require.cache[require.resolve('../src/gateway/skill-versions')];
    const v = require('../src/gateway/skill-versions');
    assert.equal(v.enabled(), false);
    assert.equal(v.snapshot('x', [], 'op'), null);
    assert.deepEqual(v.listVersions('x'), []);
    process.env.TG_SKILL_VERSIONS = '1';
    delete require.cache[require.resolve('../src/gateway/skill-versions')];
  });
});
