'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostTransportCrashTransport } = require('../research/study015/post-transport-crash');

test('L7 fault fires only after successful transport result', async () => {
  const order = [];
  const base = async () => {
    order.push('transport-returned');
    return { status: 200, connectedAddress: '140.82.121.5' };
  };
  const wrapped = createPostTransportCrashTransport(base, {
    enabled: true,
    terminate: () => {
      order.push('terminate');
      const err = new Error('simulated-sigkill');
      err.code = 'simulated-sigkill';
      throw err;
    },
  });

  await assert.rejects(() => wrapped({}, {}), { code: 'simulated-sigkill' });
  assert.deepEqual(order, ['transport-returned', 'terminate']);
});

test('L7 fault does not fire on non-success transport result', async () => {
  let terminated = false;
  const wrapped = createPostTransportCrashTransport(
    async () => ({ status: 500, connectedAddress: '140.82.121.5' }),
    { enabled: true, terminate: () => { terminated = true; } },
  );
  const result = await wrapped({}, {});
  assert.equal(result.status, 500);
  assert.equal(terminated, false);
});

test('L7 fault is inert unless explicitly enabled', async () => {
  let terminated = false;
  const wrapped = createPostTransportCrashTransport(
    async () => ({ status: 200, connectedAddress: '140.82.121.5' }),
    { enabled: false, terminate: () => { terminated = true; } },
  );
  const result = await wrapped({}, {});
  assert.equal(result.status, 200);
  assert.equal(terminated, false);
});
