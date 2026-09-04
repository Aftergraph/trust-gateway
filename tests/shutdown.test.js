const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('FS-Y3 graceful shutdown', () => {
  let origEnv;
  let sd;

  before(() => {
    origEnv = { ...process.env };
    process.env.TG_GRACEFUL_SHUTDOWN = '1';
    delete require.cache[require.resolve('../src/gateway/shutdown')];
  });

  after(() => {
    process.env = origEnv;
  });

  it('enabled respects env', () => {
    sd = require('../src/gateway/shutdown');
    assert.equal(sd.enabled(), true);
  });

  it('isDraining starts false', () => {
    assert.equal(sd.isDraining(), false);
    assert.equal(sd.drainStartedAt(), null);
  });

  it('beginDrain sets draining state', () => {
    sd.beginDrain();
    assert.equal(sd.isDraining(), true);
    assert.ok(sd.drainStartedAt() > 0);
  });

  it('graceMs default 5000', () => {
    delete process.env.TG_SHUTDOWN_GRACE_MS;
    delete require.cache[require.resolve('../src/gateway/shutdown')];
    const sd2 = require('../src/gateway/shutdown');
    assert.equal(sd2.graceMs(), 5000);
  });

  it('graceMs env override', () => {
    process.env.TG_SHUTDOWN_GRACE_MS = '15000';
    delete require.cache[require.resolve('../src/gateway/shutdown')];
    const sd2 = require('../src/gateway/shutdown');
    assert.equal(sd2.graceMs(), 15000);
  });

  it('inert when TG_GRACEFUL_SHUTDOWN unset', () => {
    delete process.env.TG_GRACEFUL_SHUTDOWN;
    delete require.cache[require.resolve('../src/gateway/shutdown')];
    const sd2 = require('../src/gateway/shutdown');
    assert.equal(sd2.enabled(), false);
    assert.equal(sd2.isDraining(), false);
    process.env.TG_GRACEFUL_SHUTDOWN = '1';
    delete require.cache[require.resolve('../src/gateway/shutdown')];
  });
});
