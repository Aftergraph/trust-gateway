const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z5 audit export + retention', () => {
  let tmpDir;
  let origEnv;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z5-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_AUDIT_EXPORT = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/audit-export-jsonl')];
    db = require('../src/gateway/db').db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS chain_entries (
        seq INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      )
    `);
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const ae = require('../src/gateway/audit-export-jsonl');
    assert.equal(ae.enabled(), true);
  });

  it('exportEvents returns file on empty chain', () => {
    const ae = require('../src/gateway/audit-export-jsonl');
    const r = ae.exportEvents({});
    assert.ok(r.file);
    assert.equal(r.count, 0);
    assert.ok(fs.existsSync(r.file));
    fs.unlinkSync(r.file);
  });

  it('applyRetention returns 0 pruned when no policy', () => {
    const ae = require('../src/gateway/audit-export-jsonl');
    const r = ae.applyRetention();
    assert.equal(r.pruned, 0);
    assert.equal(r.reason, 'no_retention_policy');
  });

  it('applyRetention with policy returns structure', () => {
    process.env.TG_AUDIT_RETENTION_MS = '86400000';
    delete require.cache[require.resolve('../src/gateway/audit-export-jsonl')];
    const ae = require('../src/gateway/audit-export-jsonl');
    const r = ae.applyRetention();
    assert.ok(typeof r.pruned === 'number');
    assert.ok(r.cutoffTs > 0);
    assert.equal(r.retentionMs, 86400000);
    delete process.env.TG_AUDIT_RETENTION_MS;
    delete require.cache[require.resolve('../src/gateway/audit-export-jsonl')];
  });

  it('inert when TG_AUDIT_EXPORT unset', () => {
    delete process.env.TG_AUDIT_EXPORT;
    delete require.cache[require.resolve('../src/gateway/audit-export-jsonl')];
    const ae = require('../src/gateway/audit-export-jsonl');
    assert.equal(ae.enabled(), false);
    assert.equal(ae.exportEvents({}), null);
    process.env.TG_AUDIT_EXPORT = '1';
    delete require.cache[require.resolve('../src/gateway/audit-export-jsonl')];
  });
});
