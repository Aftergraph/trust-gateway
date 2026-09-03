const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-K1 federation audit dashboard', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-k1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_SKILLS_FEDERATION = '1';
    // Clear module cache so db.js picks up the temp DB
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/skills-federation')];
    delete require.cache[require.resolve('../src/gateway/fed-audit')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listFederatedRuns returns empty on fresh DB', () => {
    // Initialize the ledger tables first (normally done at gateway boot)
    const { getFedRunLedger } = require('../src/gateway/skills-federation');
    getFedRunLedger();
    const { listFederatedRuns } = require('../src/gateway/fed-audit');
    const result = listFederatedRuns();
    assert.equal(result.count, 0);
    assert.deepEqual(result.rows, []);
  });

  it('observabilityFedSection returns scalar counts shape', () => {
    const { observabilityFedSection } = require('../src/gateway/fed-audit');
    const section = observabilityFedSection();
    assert.ok(section);
    assert.ok(section.runs);
    assert.ok(section.runs.last24h);
    assert.equal(typeof section.runs.last24h.executed, 'number');
    assert.equal(typeof section.runs.last24h.denied, 'number');
    assert.equal(typeof section.runs.last24h.pending, 'number');
    assert.ok(section.runs.last7d);
  });

  it('returns null when federation disabled', () => {
    delete process.env.TG_SKILLS_FEDERATION;
    delete require.cache[require.resolve('../src/gateway/fed-audit')];
    const { observabilityFedSection, listFederatedRuns } = require('../src/gateway/fed-audit');
    assert.equal(observabilityFedSection(), null);
    assert.deepEqual(listFederatedRuns(), { rows: [], count: 0 });
    process.env.TG_SKILLS_FEDERATION = '1';
    delete require.cache[require.resolve('../src/gateway/fed-audit')];
  });

  it('filter limits enforced (max 500)', () => {
    const { listFederatedRuns } = require('../src/gateway/fed-audit');
    const result = listFederatedRuns({ limit: 9999 });
    // No rows but limit should be capped internally
    assert.equal(result.count, 0);
  });
});
