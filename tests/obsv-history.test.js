const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-K3 observability historical snapshots', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-k3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_OBSV_HISTORY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/obsv-history')];
  });

  after(() => {
    process.env = origEnv;
    // Windows: luk db-forbindelsen før tmpDir slettes (ellers EPERM).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const { enabled } = require('../src/gateway/obsv-history');
    assert.equal(enabled(), true);
  });

  it('captureSnapshot persists and returns id', () => {
    const { captureSnapshot, queryHistory } = require('../src/gateway/obsv-history');
    const r = captureSnapshot({ chain: { length: 42, head: 'abc' }, tenants: { count: 1 } });
    assert.ok(r);
    assert.ok(r.id > 0);
    assert.ok(r.capturedAt > 0);
    const rows = queryHistory();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].snapshot.chain.length, 42);
  });

  it('scrubs token/key/secret fields', () => {
    const { captureSnapshot, queryHistory } = require('../src/gateway/obsv-history');
    captureSnapshot({ chain: { length: 1 }, apiToken: 'SECRET', password: 'x' });
    const rows = queryHistory({ limit: 1 });
    assert.equal(rows[0].snapshot.apiToken, undefined);
    assert.equal(rows[0].snapshot.password, undefined);
  });

  it('queryHistory filters by since/until', () => {
    const { captureSnapshot, queryHistory } = require('../src/gateway/obsv-history');
    const now = Date.now();
    captureSnapshot({ chain: { length: 100 } }, now - 10000);
    captureSnapshot({ chain: { length: 200 } }, now);
    const recent = queryHistory({ since: now - 5000 });
    assert.ok(recent.length >= 1);
    assert.equal(recent[0].snapshot.chain.length, 200);
  });

  it('snapshot size cap returns error', () => {
    const { captureSnapshot } = require('../src/gateway/obsv-history');
    const huge = { data: 'x'.repeat(70000) };
    const r = captureSnapshot(huge);
    assert.equal(r.error, 'snapshot_too_large');
    assert.ok(r.bytes > 64000);
  });

  it('cleanupOldSnapshots removes old', () => {
    const { captureSnapshot, cleanupOldSnapshots } = require('../src/gateway/obsv-history');
    const old = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days ago
    captureSnapshot({ chain: { length: 1 } }, old);
    const result = cleanupOldSnapshots();
    assert.ok(result.deletedCount >= 1);
  });

  it('inert when TG_OBSV_HISTORY unset', () => {
    delete process.env.TG_OBSV_HISTORY;
    delete require.cache[require.resolve('../src/gateway/obsv-history')];
    const { captureSnapshot, queryHistory, enabled } = require('../src/gateway/obsv-history');
    assert.equal(enabled(), false);
    assert.equal(captureSnapshot({ x: 1 }), null);
    assert.deepEqual(queryHistory(), []);
    process.env.TG_OBSV_HISTORY = '1';
    delete require.cache[require.resolve('../src/gateway/obsv-history')];
  });
});
