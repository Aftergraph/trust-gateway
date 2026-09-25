'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStudy015ReconciliationRecord } = require('../research/study015/reconciliation-record');

const SHA = 'a'.repeat(40);
const BASE = {
  schema: 'study015.effect-reconciliation/1.0',
  status: 'COMMITTED_RECOVERED',
  request_id: 'req/study015/live-5',
  correlation_id: 'causal/study015/live-5',
  execution_context_id: 'ctx_' + '1'.repeat(32),
  action_id: 'act_' + 'e'.repeat(32),
  effect_id: 'effect/study015/live-5',
  repository: 'Aftergraph/runtime',
  ref: 'refs/heads/study015/l7-indeterminate-effect-proof-target',
  expected_sha: SHA,
  observed_sha: SHA,
  observed_via: 'github_exact_ref_readback',
};

test('accepts exact committed remote reconciliation bound to original effect identity', () => {
  const out = validateStudy015ReconciliationRecord(BASE, {
    executionContextId: BASE.execution_context_id,
    actionId: BASE.action_id,
    effectId: BASE.effect_id,
    correlationId: BASE.correlation_id,
    repository: BASE.repository,
    ref: BASE.ref,
    expectedSha: SHA,
  });
  assert.equal(out.status, 'COMMITTED_RECOVERED');
  assert.equal(out.observed_sha, SHA);
});

test('rejects divergent remote state', () => {
  assert.throws(
    () => validateStudy015ReconciliationRecord({ ...BASE, observed_sha: 'b'.repeat(40) }),
    { code: 'study015_reconciliation_remote_mismatch' },
  );
});

test('rejects rebound execution identity', () => {
  assert.throws(
    () => validateStudy015ReconciliationRecord(BASE, {
      executionContextId: 'ctx_' + '2'.repeat(32),
    }),
    { code: 'study015_reconciliation_binding_mismatch' },
  );
});
