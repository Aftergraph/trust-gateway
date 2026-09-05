'use strict';
// P2 delegation-chain store tests — pure domain, no I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DelegationChain } = require('../src/gateway/delegation-chain');

test('DelegationChain: empty store returns valid=false, error=null for any verify query', () => {
  const dc = new DelegationChain();
  assert.deepEqual(dc.verify('msg_1'), { valid: false, error: null });
  assert.equal(dc.tree('room_x'), null);
});

test('DelegationChain: record a root message (no parent)', () => {
  const dc = new DelegationChain();
  dc.record(null, 'msg_root', { kind: 'mission_proposal', from: 'alice' });
  const c = dc.chain('msg_root');
  assert.equal(c.length, 1);
  assert.equal(c[0].msgId, 'msg_root');
  assert.equal(c[0].kind, 'mission_proposal');
  assert.equal(c[0].from, 'alice');
});

test('DelegationChain: record parent-child edge and build chain from child', () => {
  const dc = new DelegationChain();
  dc.record(null, 'msg_a', { kind: 'goal', from: 'alice' });
  dc.record('msg_a', 'msg_b', { kind: 'delegate', from: 'bot1' });
  dc.record('msg_b', 'msg_c', { kind: 'subdelegate', from: 'bot2' });
  const c = dc.chain('msg_c');
  assert.equal(c.length, 3);
  assert.equal(c[0].msgId, 'msg_a');
  assert.equal(c[1].msgId, 'msg_b');
  assert.equal(c[2].msgId, 'msg_c');
});

test('DelegationChain: record sibling branches under same parent', () => {
  const dc = new DelegationChain();
  dc.record(null, 'root', { kind: 'goal', from: 'alice' }, 'room_1');
  dc.record('root', 'child_1', { kind: 'delegate', from: 'bot1' }, 'room_1');
  dc.record('root', 'child_2', { kind: 'delegate', from: 'bot2' }, 'room_1');
  const t = dc.tree('room_1');
  assert.ok(t);
  assert.equal(t.msgId, 'root');
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].msgId, 'child_1');
  assert.equal(t.children[1].msgId, 'child_2');
});

test('DelegationChain: tree groups by roomId', () => {
  const dc = new DelegationChain();
  dc.record(null, 'r1_root', { kind: 'goal', from: 'alice' }, 'room_a');
  dc.record(null, 'r2_root', { kind: 'goal', from: 'bob' }, 'room_b');
  const ta = dc.tree('room_a');
  assert.equal(ta.msgId, 'r1_root');
  const tb = dc.tree('room_b');
  assert.equal(tb.msgId, 'r2_root');
});

test('DelegationChain: verify returns structured result for unbroken chain', () => {
  const dc = new DelegationChain();
  dc.record(null, 'a', { kind: 'goal', from: 'alice' });
  dc.record('a', 'b', { kind: 'delegate', from: 'bot1' });
  assert.deepEqual(dc.verify('b'), { valid: true, error: null });
});

test('DelegationChain: verify detects missing edge', () => {
  const orphan = new DelegationChain();
  orphan.record('nonexistent', 'orphan', { kind: 'delegate', from: 'bot1' });
  assert.deepEqual(orphan.verify('orphan'), { valid: false, error: 'missing_edge' });
});

test('DelegationChain: verify returns no-error for unknown msgId', () => {
  const dc = new DelegationChain();
  dc.record(null, 'a', { kind: 'goal', from: 'alice' });
  assert.deepEqual(dc.verify('unknown'), { valid: false, error: null });
});

test('DelegationChain: record validates kind is non-empty string', () => {
  const dc = new DelegationChain();
  assert.throws(() => dc.record(null, 'x', { kind: '', from: 'alice' }), /kind/);
  assert.throws(() => dc.record(null, 'x', { kind: 123, from: 'alice' }), /kind/);
});

test('DelegationChain: record validates msgId is non-empty string', () => {
  const dc = new DelegationChain();
  assert.throws(() => dc.record(null, '', { kind: 'goal', from: 'alice' }), /msgId/);
  assert.throws(() => dc.record(null, null, { kind: 'goal', from: 'alice' }), /msgId/);
});
