const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-Z1 tenant metrics aggregates', () => {
  let tmpDir;
  let origEnv;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-z1-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    // Ensure chain_entries table exists (same schema as sql-chain.js)
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
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.enabled(), true);
  });

  it('getMetrics returns null when disabled', () => {
    delete process.env.TG_TENANT_METRICS;
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.getMetrics('acme'), null);
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
  });

  it('getMetrics returns structure on empty chain', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getMetrics('acme');
    assert.equal(r.tenant, 'acme');
    assert.equal(r.totalEvents, 0);
    assert.ok(Array.isArray(r.byType));
    assert.equal(r.lastActivityAt, null);
  });

  it('getAllTenantsSummary returns structure', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getAllTenantsSummary();
    assert.ok(r.tenantCount >= 0);
    assert.ok(Array.isArray(r.tenants));
  });

  it('getMetrics with custom window', () => {
    const tm = require('../src/gateway/tenant-metrics');
    const r = tm.getMetrics('acme', 7200000);
    assert.equal(r.windowMs, 7200000);
  });

  it('getMetrics counts events from chain_entries payload', () => {
    const tm = require('../src/gateway/tenant-metrics');
    // Insert test events into chain_entries
    const now = Date.now();
    db.prepare('INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)').run(
      100, now, 'prev', 'hash1', JSON.stringify({ tenant: 'testco', type: 'login', data: {} })
    );
    db.prepare('INSERT INTO chain_entries(seq, ts, prev_hash, hash, payload) VALUES(?,?,?,?,?)').run(
      101, now, 'prev', 'hash2', JSON.stringify({ tenant: 'testco', type: 'logout', data: {} })
    );
    const r = tm.getMetrics('testco');
    assert.equal(r.totalEvents, 2);
    assert.ok(r.byType.some(t => t.type === 'login'));
  });

  it('inert when TG_TENANT_METRICS unset', () => {
    delete process.env.TG_TENANT_METRICS;
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
    const tm = require('../src/gateway/tenant-metrics');
    assert.equal(tm.enabled(), false);
    assert.equal(tm.getAllTenantsSummary(), null);
    process.env.TG_TENANT_METRICS = '1';
    delete require.cache[require.resolve('../src/gateway/tenant-metrics')];
  });
});
