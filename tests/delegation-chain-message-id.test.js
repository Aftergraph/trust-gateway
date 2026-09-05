'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DelegationChain, DurableDelegationChain } = require('../src/gateway/delegation-chain');
const { hookRoomStore } = require('../src/gateway/mounts/27-delegation-chain');

test('delegation hook records the actual delivered message id', async () => {
  const chain = new DelegationChain();
  const room = { id: 'room-a', messages: [{}] };
  const store = {
    rooms: new Map([['room-a', room]]),
    deliver: async () => ({ ok: true, message: { id: 'rm_actual_42' } }),
  };
  hookRoomStore(store, chain);
  const result = await store.deliver('room-a', {
    from: 'forge', body: 'child',
    chain: [{ parentMsgId: 'rm_root', kind: 'delegate' }],
  });
  assert.equal(result.message.id, 'rm_actual_42');
  assert.ok(chain.chain('rm_actual_42'), 'chain uses result.message.id');
  assert.equal(chain.chain('rm_000001'), null, 'chain does not fall back to array index');
});

test('durable graph preserves non-index message ids across reload', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-id-')), 'chain.json');
  const first = new DurableDelegationChain({ file });
  first.record(null, 'rm_custom-root', { kind: 'message', from: 'alice' }, 'room-a');
  first.record('rm_custom-root', 'rm_custom-child', { kind: 'delegate', from: 'forge' }, 'room-a');
  const second = new DurableDelegationChain({ file });
  assert.equal(second.verify('rm_custom-child'), true);
  assert.equal(second.chain('rm_custom-child')[1].msgId, 'rm_custom-child');
});
