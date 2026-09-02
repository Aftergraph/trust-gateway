'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ApprovalStore } = require('../src/gateway/approvals');

function fakeNow() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test('request → approve', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  const r = s.request({ bot: { name: 'forge' }, tool: 'shell.run', args: 'rm /tmp/x' });
  assert.equal(r.status, 'pending');
  const res = s.resolve(r.id, 'approve', 'atlas');
  assert.equal(res.ok, true);
  assert.equal(s.get(r.id).status, 'approved');
  assert.equal(s.get(r.id).resolvedBy, 'atlas');
});

test('deny', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  const r = s.request({ tool: 'shell.run' });
  const res = s.resolve(r.id, 'deny', 'jonas');
  assert.equal(res.ok, true);
  assert.equal(s.get(r.id).status, 'denied');
});

test('double resolve fails', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  const r = s.request({ tool: 'shell.run' });
  s.resolve(r.id, 'approve', 'a');
  const again = s.resolve(r.id, 'approve', 'b');
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_approved');
});

test('expiry fails closed', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now, ttlMs: 1000 });
  const r = s.request({ tool: 'shell.run' });
  f.tick(2000); // past TTL
  const res = s.resolve(r.id, 'approve', 'a');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'expired');
  assert.equal(s.get(r.id).status, 'expired');
});

test('approver required', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  const r = s.request({ tool: 'shell.run' });
  const res = s.resolve(r.id, 'approve', '');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'approver_required');
});

test('bad verdict rejected', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  const r = s.request({ tool: 'shell.run' });
  const res = s.resolve(r.id, 'sure-whatever', 'a');
  assert.equal(res.ok, false);
});

test('not found', () => {
  const f = fakeNow();
  const s = new ApprovalStore({ now: f.now });
  assert.equal(s.resolve('apr_999999', 'approve', 'a').ok, false);
});