const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-M3 rate-limit ledger', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-m3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_RATE_LEDGER = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
  });

  after(() => {
    process.env = origEnv;
    // Windows keeps SQLite handles open briefly after require-cache purges; a
    // single rmSync races the GC and throws EPERM. Retry briefly, then leave
    // the dir for OS temp cleanup — never fail the suite on temp cleanup.
    // Windows: luk db-forbindelsen først (ellers låses filen).
    try { require('../src/gateway/db').closeDb(); } catch { /* uåbnet */ }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 4 && e.code === 'EPERM') break; // best-effort cleanup
        const until = Date.now() + 100;
        while (Date.now() < until) {} // ponytail: 100ms busy-wait, adequate for test cleanup
      }
    }
  });

  it('hit increments count', () => {
    const l = require('../src/gateway/rate-ledger');
    const r1 = l.hit('k1', 60000, 10, Date.now());
    const r2 = l.hit('k1', 60000, 10, Date.now());
    assert.equal(r1.count, 1);
    assert.equal(r2.count, 2);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
  });

  it('allowed=false over max', () => {
    const l = require('../src/gateway/rate-ledger');
    const r = l.hit('k2', 60000, 2, Date.now());
    l.hit('k2', 60000, 2, Date.now());
    const over = l.hit('k2', 60000, 2, Date.now());
    assert.equal(r.count, 1);
    assert.equal(over.count, 3);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfterMs > 0);
  });

  it('getCount returns current count', () => {
    const l = require('../src/gateway/rate-ledger');
    l.hit('k3', 60000, 100, Date.now());
    l.hit('k3', 60000, 100, Date.now());
    assert.equal(l.getCount('k3', 60000), 2);
  });

  it('reset clears all rows for key', () => {
    const l = require('../src/gateway/rate-ledger');
    l.hit('k4', 60000, 100, Date.now());
    l.hit('k4', 60000, 100, Date.now());
    assert.equal(l.reset('k4'), 1);
    assert.equal(l.getCount('k4', 60000), 0);
  });

  it('inert when TG_RATE_LEDGER=0', () => {
    process.env.TG_RATE_LEDGER = '0';
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
    const l = require('../src/gateway/rate-ledger');
    assert.equal(l.enabled(), false);
    const r = l.hit('k5', 60000, 1, Date.now());
    assert.equal(r.count, 0);
    assert.equal(r.allowed, true);
    assert.equal(l.reset('k5'), 0);
    process.env.TG_RATE_LEDGER = '1';
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
  });

  it('windowMs must be positive', () => {
    const l = require('../src/gateway/rate-ledger');
    const r = l.hit('k6', 0, 10, Date.now());
    assert.equal(r.allowed, true);
    assert.equal(r.count, 0);
  });

  it('listCurrent returns only current-window buckets, ranked', () => {
    const l = require('../src/gateway/rate-ledger');
    const now = Date.now();
    l.hit('ldA', 60000, 100, now);
    l.hit('ldA', 60000, 100, now);
    l.hit('ldB', 60000, 100, now);
    // Old window bucket must NOT appear in the current-window view.
    l.hit('ldOld', 60000, 100, now - 120000);
    const rows = l.listCurrent(60000, now);
    const keys = rows.map(r => r.key);
    assert.ok(keys.includes('ldA'), 'current-window bucket listed');
    assert.ok(keys.includes('ldB'), 'current-window bucket listed');
    assert.ok(!keys.includes('ldOld'), 'stale-window bucket excluded');
    const a = rows.find(r => r.key === 'ldA');
    const b = rows.find(r => r.key === 'ldB');
    assert.ok(rows.indexOf(a) < rows.indexOf(b), 'highest count ranked first');
    assert.equal(a.count, 2);
    assert.equal(a.windowMs, 60000);
  });

  it('listCurrent is inert when TG_RATE_LEDGER=0', () => {
    process.env.TG_RATE_LEDGER = '0';
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
    const l = require('../src/gateway/rate-ledger');
    assert.deepEqual(l.listCurrent(60000), []);
    process.env.TG_RATE_LEDGER = '1';
    delete require.cache[require.resolve('../src/gateway/rate-ledger')];
  });
});
