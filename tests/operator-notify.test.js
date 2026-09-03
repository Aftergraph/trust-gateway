const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('FS-W3 operator notify prefs', () => {
  let tmpDir;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-w3-'));
    origEnv = { ...process.env };
    process.env.TG_DB_FILE = path.join(tmpDir, 'gateway.db');
    process.env.TG_OPERATOR_NOTIFY = '1';
    delete require.cache[require.resolve('../src/gateway/db')];
    delete require.cache[require.resolve('../src/gateway/operator-notify')];
  });

  after(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enabled respects env', () => {
    const n = require('../src/gateway/operator-notify');
    assert.equal(n.enabled(), true);
  });

  it('get returns empty for new operator', () => {
    const n = require('../src/gateway/operator-notify');
    assert.deepEqual(n.get('new-op'), []);
  });

  it('set persists', () => {
    const n = require('../src/gateway/operator-notify');
    assert.equal(n.set('op1', 'login', 'audit_chain', true), true);
    const prefs = n.get('op1');
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0].eventType, 'login');
    assert.equal(prefs[0].enabled, true);
  });

  it('isSubscribed returns true after set', () => {
    const n = require('../src/gateway/operator-notify');
    const r = n.set('op2', 'login', 'webhook', true);
    assert.equal(r, true);
    assert.equal(n.isSubscribed('op2', 'login', 'webhook'), true);
    assert.equal(n.isSubscribed('op2', 'login', 'sms'), false);
  });

  it('listSubscribers filters by event+channel', () => {
    const n = require('../src/gateway/operator-notify');
    n.set('op3', 'quota', 'webhook', true);
    n.set('op4', 'quota', 'webhook', true);
    n.set('op5', 'login', 'webhook', true);
    n.set('op3', 'quota', 'webhook', false); // disable
    const subs = n.listSubscribers('quota', 'webhook');
    assert.ok(subs.includes('op4'));
    assert.ok(!subs.includes('op3')); // disabled
    assert.ok(!subs.includes('op5')); // different event
  });

  it('remove deletes pref', () => {
    const n = require('../src/gateway/operator-notify');
    n.set('op6', 'login', 'audit_chain', true);
    assert.equal(n.remove('op6', 'login', 'audit_chain'), true);
    assert.equal(n.isSubscribed('op6', 'login', 'audit_chain'), false);
  });

  it('inert when TG_OPERATOR_NOTIFY unset', () => {
    delete process.env.TG_OPERATOR_NOTIFY;
    delete require.cache[require.resolve('../src/gateway/operator-notify')];
    const n = require('../src/gateway/operator-notify');
    assert.equal(n.enabled(), false);
    assert.deepEqual(n.get('any'), []);
    assert.equal(n.isSubscribed('any', 'x', 'y'), false);
    process.env.TG_OPERATOR_NOTIFY = '1';
    delete require.cache[require.resolve('../src/gateway/operator-notify')];
  });
});
