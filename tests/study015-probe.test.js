'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runProbe } = require('../scripts/study015-probe');

test('STUDY-015 probe executes real Trust Gateway policy/approval/audit path', async () => {
  const receipt = await runProbe();
  assert.equal(receipt.schema, 'study015.probe/1.0');
  assert.equal(receipt.component, 'trust-gateway');
  assert.equal(receipt.network_used, false);
  assert.match(receipt.source_head, /^[a-f0-9]{40}$/);
  assert.ok(Object.values(receipt.mechanisms).every(Boolean));
  assert.equal(receipt.observations.destructive_decision, 'needs_approval');
  assert.equal(receipt.observations.worker_approval_error, 'operator_required');
  assert.equal(receipt.observations.shell_dispatch_count, 1);
});
