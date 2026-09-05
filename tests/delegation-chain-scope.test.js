'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-scope-')), 'rooms.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DelegationChain } = require('../src/gateway/delegation-chain');
const { getChain, hookRoomStore } = require('../src/gateway/mounts/27-delegation-chain');
const { getRoomStore } = require('../src/gateway/groups');
const { Gateway } = require('../src/gateway/server');

test('delegation mount: each gateway gets an isolated chain', () => {
  const a = new Gateway({ mountFiles: false });
  const b = new Gateway({ mountFiles: false });
  try {
    const ca = getChain(a);
    const cb = getChain(b);
    assert.notEqual(ca, cb);
    ca.record(null, 'a-msg', { kind: 'goal', from: 'tenant-a' }, 'room-a');
    assert.equal(ca.chain('a-msg')[0].from, 'tenant-a');
    assert.equal(cb.chain('a-msg'), null);
  } finally {
    a.server?.close();
    b.server?.close();
  }
});

test('delegation mount: hooks use the supplied gateway chain, not another gateway', async () => {
  const bot = { token: 'tok-forge', role: 'worker', capabilities: ['*'] };
  const a = new Gateway({ mountFiles: false, bots: { forge: bot } });
  const b = new Gateway({ mountFiles: false, bots: { forge: bot } });
  try {
    const ca = getChain(a);
    const cb = getChain(b);
    const storeA = getRoomStore(a);
    const storeB = getRoomStore(b);
    hookRoomStore(storeA, ca);
    hookRoomStore(storeB, cb);
    const roomA = storeA.create({ name: 'A', bots: ['forge'], humans: ['alice'] });
    const roomB = storeB.create({ name: 'B', bots: ['forge'], humans: ['bob'] });
    const ra = await storeA.deliver(roomA.id, { from: 'alice', body: 'A root' });
    const rb = await storeB.deliver(roomB.id, { from: 'bob', body: 'B root' });
    const chainA = ca.chain(ra.message.id);
    const chainB = cb.chain(rb.message.id);
    assert.equal(chainA[0].from, 'alice');
    assert.equal(chainB[0].from, 'bob');
    // Both gateways may allocate the same local message ID; their graph data
    // must nevertheless remain isolated by gateway instance.
    assert.notEqual(chainA[0].from, chainB[0].from);
  } finally {
    a.server?.close();
    b.server?.close();
  }
});
