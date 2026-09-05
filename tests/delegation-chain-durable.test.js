'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DurableDelegationChain } = require('../src/gateway/delegation-chain');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chain-durable-')), 'chain.json');
}

test('DurableDelegationChain: persists records and reloads after restart', () => {
  const file = tempFile();
  const first = new DurableDelegationChain({ file });
  first.record(null, 'root', { kind: 'goal', from: 'alice' }, 'room-a');
  first.record('root', 'child', { kind: 'delegate', from: 'bot-a' }, 'room-a');

  const second = new DurableDelegationChain({ file });
  assert.deepEqual(second.chain('child'), [
    { msgId: 'root', kind: 'goal', from: 'alice' },
    { msgId: 'child', kind: 'delegate', from: 'bot-a' },
  ]);
  assert.deepEqual(second.verify('child'), { valid: true, error: null });
});

test('DurableDelegationChain: corrupt file fails closed', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not-json');
  assert.throws(() => new DurableDelegationChain({ file }), /refusing to load|unparseable/);
});

test('DurableDelegationChain: invalid shape fails closed', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, edges: [{ nope: true }] }));
  assert.throws(() => new DurableDelegationChain({ file }), /invalid|edge/);
});

test('DurableDelegationChain: writes mode 0600 and leaves no temporary file', () => {
  const file = tempFile();
  const chain = new DurableDelegationChain({ file });
  chain.record(null, 'root', { kind: 'goal', from: 'alice' }, 'room-a');
  assert.ok((fs.statSync(file).mode & 0o777) === 0o600 || process.platform === 'win32');
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('DurableDelegationChain: room trees remain scoped after reload', () => {
  const file = tempFile();
  const first = new DurableDelegationChain({ file });
  first.record(null, 'a', { kind: 'goal', from: 'a' }, 'room-a');
  first.record(null, 'b', { kind: 'goal', from: 'b' }, 'room-b');
  const second = new DurableDelegationChain({ file });
  assert.equal(second.tree('room-a').msgId, 'a');
  assert.equal(second.tree('room-b').msgId, 'b');
});
