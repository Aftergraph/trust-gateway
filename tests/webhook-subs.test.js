const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-L2 webhook subscriptions', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-l2-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_WEBHOOK_SUBS = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/webhook-subs')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const { enabled } = require('../src/gateway/webhook-subs');
    assert.equal(enabled(), true);
  });

  it('create stores sub with id', () => {
    const subs = require('../src/gateway/webhook-subs');
    const r = subs.create({ url: 'https://example.com/hook', eventTypes: ['login'], by: 'op1' });
    assert.ok(r.id > 0);
    assert.equal(r.url, 'https://example.com/hook');
    assert.deepEqual(r.eventTypes, ['login']);
  });

  it('list returns created subs', () => {
    const subs = require('../src/gateway/webhook-subs');
    subs.create({ url: 'https://a.com/h', eventTypes: ['x'], by: 'op' });
    const all = subs.list();
    assert.ok(all.length >= 2);
  });

  it('invalid url refused', () => {
    const subs = require('../src/gateway/webhook-subs');
    assert.throws(() => subs.create({ url: 'not-a-url', eventTypes: ['x'], by: 'op' }), /invalid_url/);
  });

  it('empty event types refused', () => {
    const subs = require('../src/gateway/webhook-subs');
    assert.throws(() => subs.create({ url: 'https://x.com', eventTypes: [], by: 'op' }), /invalid_event_types/);
  });

  it('remove deletes sub', () => {
    const subs = require('../src/gateway/webhook-subs');
    const r = subs.create({ url: 'https://r.com', eventTypes: ['y'], by: 'op' });
    assert.equal(subs.remove(r.id), true);
    assert.equal(subs.get(r.id), null);
  });

  it('recordDelivery updates lastDeliveredAt', () => {
    const subs = require('../src/gateway/webhook-subs');
    const r = subs.create({ url: 'https://d.com', eventTypes: ['z'], by: 'op' });
    subs.recordDelivery(r.id, true);
    const updated = subs.get(r.id);
    assert.ok(updated.lastDeliveredAt > 0);
    assert.equal(updated.lastError, null);
  });

  it('inert when TG_WEBHOOK_SUBS unset', () => {
    const saved = process.env.TG_WEBHOOK_SUBS;
    delete process.env.TG_WEBHOOK_SUBS;
    delete require.cache[require.resolve('../src/gateway/webhook-subs')];
    const subs2 = require('../src/gateway/webhook-subs');
    assert.equal(subs2.enabled(), false);
    assert.equal(subs2.create({ url: 'https://x.com', eventTypes: ['x'], by: 'op' }), null);
    assert.deepEqual(subs2.list(), []);
    process.env.TG_WEBHOOK_SUBS = saved;
    delete require.cache[require.resolve('../src/gateway/webhook-subs')];
  });
});
