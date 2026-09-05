'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Gateway } = require('../src/gateway/server');
const { getChain } = require('../src/gateway/mounts/27-delegation-chain');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-mount-')), 'chain.json');
}

test('mount uses durable chain when gateway receives delegationChainFile', () => {
  const file = tempFile();
  const first = new Gateway({ mountFiles: false, delegationChainFile: file });
  const second = new Gateway({ mountFiles: false, delegationChainFile: file });
  try {
    getChain(first).record(null, 'persisted-root', { kind: 'goal', from: 'tenant-a' }, 'room-a');
    const reloaded = getChain(second);
    assert.deepEqual(reloaded.chain('persisted-root'), [
      { msgId: 'persisted-root', kind: 'goal', from: 'tenant-a' },
    ]);
  } finally {
    first.server?.close();
    second.server?.close();
  }
});

test('mount refuses a corrupt durable chain at gateway construction', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{corrupt');
  const gateway = new Gateway({ mountFiles: false, delegationChainFile: file });
  try {
    assert.throws(() => getChain(gateway), /refusing to load|unparseable/);
  } finally {
    gateway.server?.close();
  }
});
