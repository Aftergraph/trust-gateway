'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

// P2 delegation-chain mount tests — room-store integration (direct hook).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { getRoomStore } = require('../src/gateway/groups');
const { DelegationChain } = require('../src/gateway/delegation-chain');
const { hookRoomStore } = require('../src/gateway/mounts/27-delegation-chain');

function freshChain() {
  return new DelegationChain();
}

test('hookRoomStore records delegation edges from A2A chain field', async () => {
  const gw = new Gateway({
    bots: { forge: { token: 'tok-f', role: 'worker', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  try {
    const store = getRoomStore(gw);
    const chain = freshChain();
    hookRoomStore(store, chain);

    const room = store.create({ name: 'test room', bots: ['forge'], humans: ['alice'] });

    // Deliver root message (no chain)
    const r1 = await store.deliver(room.id, { from: 'alice', body: 'root goal' });
    assert.ok(r1.ok);
    const rootId = r1.message.id; // e.g. rm_000001

    // Deliver delegated message with chain referencing the root by its actual message ID
    const r2 = await store.deliver(room.id, {
      from: 'forge',
      body: 'executing step 1',
      chain: [{ parentMsgId: rootId, kind: 'delegate' }],
    });
    assert.ok(r2.ok);
    const childId = r2.message.id; // e.g. rm_000002

    // Check the delegation chain was recorded
    const c = chain.chain(childId);
    assert.ok(c, 'chain should exist for child message');
    assert.equal(c.length, 2, 'chain should have 2 hops (root + delegate)');
    assert.equal(c[0].msgId, rootId);
    assert.equal(c[1].msgId, childId);
    assert.equal(c[1].kind, 'delegate');

    // Tree should exist for the room
    const tree = chain.tree(room.id);
    assert.ok(tree);
  } finally {
    gw.server?.close();
  }
});

test('hookRoomStore handles messages without chain field', async () => {
  const gw = new Gateway({
    bots: { forge: { token: 'tok-f', role: 'worker', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  try {
    const store = getRoomStore(gw);
    const chain = freshChain();
    hookRoomStore(store, chain);

    const room = store.create({ name: 'quiet room', bots: ['forge'], humans: ['alice'] });

    const r1 = await store.deliver(room.id, { from: 'alice', body: 'hello' });
    const r2 = await store.deliver(room.id, { from: 'forge', body: 'hi back' });

    // No chain field → recorded as root nodes (1-hop chain)
    const c0 = chain.chain(r1.message.id);
    assert.ok(c0);
    assert.equal(c0.length, 1);
    assert.equal(c0[0].msgId, r1.message.id);
    const c1 = chain.chain(r2.message.id);
    assert.ok(c1);
    assert.equal(c1.length, 1);
  } finally {
    gw.server?.close();
  }
});

test('hookRoomStore validates chain array format via store', async () => {
  const gw = new Gateway({
    bots: { forge: { token: 'tok-f', role: 'worker', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  try {
    const store = getRoomStore(gw);
    const chain = freshChain();
    hookRoomStore(store, chain);

    const room = store.create({ name: 'validation', bots: ['forge'], humans: ['alice'] });

    // chain must be array — string should be rejected by the store's built-in validation
    const r = await store.deliver(room.id, { from: 'alice', body: 'test', chain: 'not-an-array' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'chain_must_be_array');
  } finally {
    gw.server?.close();
  }
});

test('hookRoomStore: chain exists with 3 messages', async () => {
  const gw = new Gateway({
    bots: { forge: { token: 'tok-f', role: 'worker', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  try {
    const store = getRoomStore(gw);
    const chain = freshChain();
    hookRoomStore(store, chain);

    const room = store.create({ name: 'deep chain', bots: ['forge'], humans: ['alice'] });

    const r1 = await store.deliver(room.id, { from: 'alice', body: 'goal' });
    const r2 = await store.deliver(room.id, { from: 'forge', body: 'step 1', chain: [{ parentMsgId: r1.message.id, kind: 'delegate' }] });
    const r3 = await store.deliver(room.id, { from: 'forge', body: 'step 2', chain: [{ parentMsgId: r2.message.id, kind: 'subdelegate' }] });

    const c = chain.chain(r3.message.id);
    assert.ok(c);
    assert.equal(c.length, 3);
    assert.equal(c[0].msgId, r1.message.id);
    assert.equal(c[1].msgId, r2.message.id);
    assert.equal(c[2].msgId, r3.message.id);
    assert.equal(c[1].kind, 'delegate');
    assert.equal(c[2].kind, 'subdelegate');
  } finally {
    gw.server?.close();
  }
});
