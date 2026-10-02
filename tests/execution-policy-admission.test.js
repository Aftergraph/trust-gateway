'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bindExecutionPolicyAdmission } = require('../src/gateway/execution-policy-admission');

function planning() {
  return {
    schema: 'aftergraph.execution-policy-request/v1',
    authority_ref: 'grant://1',
    environment: 'windows',
    effect_class: 'reversible',
    capability: 'computer.click',
    uncertainty: 0.05,
    structured_state_available: true,
    vision_available: false,
    semantic_reasoning_required: false,
    latency_budget_ms: 20,
  };
}

function admission(decision = 'admitted') {
  return {
    schemaVersion: 'aftergraph.tool-action-admission/v1',
    requestId: 'req_1',
    capability: 'computer.click',
    decision,
    authorityGranted: false,
  };
}

test('binds only an admitted tool action', () => {
  const result = bindExecutionPolicyAdmission({
    planningRequest: planning(),
    toolAdmission: admission(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.admitted, true);
});

test('keeps pending approval pending', () => {
  const result = bindExecutionPolicyAdmission({
    planningRequest: planning(),
    toolAdmission: admission('pending_approval'),
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.admitted, false);
});

test('fails closed on capability mismatch', () => {
  const p = planning();
  p.capability = 'computer.type';
  const result = bindExecutionPolicyAdmission({
    planningRequest: p,
    toolAdmission: admission(),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.admitted, false);
});
