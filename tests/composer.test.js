'use strict';
// Universal composer v1 (P1) — meta-carrying messages + context-preview tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const uniqueId = `${process.pid}-${Date.now()}-composer`;
process.env.TG_DB_FILE = path.join(os.tmpdir(), `test-gateway-${uniqueId}.db`);

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationStore } = require('../src/gateway/conversations');

function mkStore() {
  return new ConversationStore('main');
}

test('composer: appendMessage stores attachments + mentions meta in hashed payload', () => {
  const store = mkStore();
  const conv = store.create('composer test');
  const meta = {
    attachments: [{ name: 'shot.png', mime: 'image/png', size: 1024, sha256: 'abc' }],
    mentions: ['agent_deploy'],
  };
  const msg = store.appendMessage(conv.id, 'user', 'look at this', meta);
  assert.equal(msg.meta.attachments[0].name, 'shot.png');
  assert.deepEqual(msg.meta.mentions, ['agent_deploy']);
  // meta is part of the payload hash — different meta → different hash
  const withoutMeta = store.appendMessage(conv.id, 'user', 'look at this');
  assert.notEqual(msg.payload_hash, withoutMeta.payload_hash);
});

test('composer: meta is optional (backward compatible)', () => {
  const store = mkStore();
  const conv = store.create('plain');
  const msg = store.appendMessage(conv.id, 'user', 'plain message');
  assert.ok(!msg.meta, 'no meta field when none passed');
});

test('preview: message tail bounded by tail param', () => {
  const store = mkStore();
  const conv = store.create('preview test');
  for (let i = 0; i < 15; i++) store.appendMessage(conv.id, 'user', `msg ${i}`);
  const snap = store.preview(conv.id, { tail: 10 });
  assert.equal(snap.tail_count, 10);
  assert.equal(snap.message_tail[0].content, 'msg 5', 'tail starts at the right message');
  assert.equal(snap.message_tail[9].content, 'msg 14');
});

test('preview: empty conversation returns empty tail', () => {
  const store = mkStore();
  const conv = store.create('empty');
  const snap = store.preview(conv.id);
  assert.equal(snap.tail_count, 0);
  assert.deepEqual(snap.message_tail, []);
});

test('validation: malformed meta is stored as-is by store (mount validates shape)', () => {
  // The mount (21-conversations.js) enforces the array-shape validation; the store
  // only guarantees hash-integrity of whatever the mount passes through.
  const store = mkStore();
  const conv = store.create('v');
  const msg = store.appendMessage(conv.id, 'user', 'x', { attachments: 'nope' });
  assert.equal(msg.meta.attachments, 'nope');
});