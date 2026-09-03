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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});
