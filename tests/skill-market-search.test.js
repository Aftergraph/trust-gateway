const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z3 skill marketplace search', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILL_MARKET_SEARCH = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skill-market-search')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const sm = require('../src/gateway/skill-market-search');
    assert.equal(sm.enabled(), true);
  });

  it('search returns structure on empty table', () => {
    const sm = require('../src/gateway/skill-market-search');
    const r = sm.search({});
    assert.equal(r.total, 0);
    assert.ok(Array.isArray(r.skills));
    assert.equal(r.limit, 20);
  });

  it('search with q filter returns structure', () => {
    const sm = require('../src/gateway/skill-market-search');
    const r = sm.search({ q: 'test', limit: 5, offset: 0 });
    assert.equal(r.limit, 5);
    assert.ok(Array.isArray(r.skills));
  });

  it('inert when TG_SKILL_MARKET_SEARCH unset', () => {
    delete process.env.TG_SKILL_MARKET_SEARCH;
    delete require.cache[require.resolve('../src/gateway/skill-market-search')];
    const sm = require('../src/gateway/skill-market-search');
    assert.equal(sm.enabled(), false);
    assert.equal(sm.search({}), null);
    process.env.TG_SKILL_MARKET_SEARCH = '1';
    delete require.cache[require.resolve('../src/gateway/skill-market-search')];
  });
});
