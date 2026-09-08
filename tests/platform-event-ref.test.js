'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectPlatformEventRef } = require('../src/gateway/platform-event-ref');

const correlation = Object.freeze({
  execution_context_id: 'ctx_11111111111111111111111111111111',
  tenant_id: 'ten_11111111111111111111111111111111',
  principal_id: 'prn_11111111111111111111111111111111',
  mission_id: 'mission-platform-fabric-001',
  authority_lease_id: 'auth_11111111111111111111111111111111',
  work_id: 'wrk_11111111111111111111111111111111',
  admission_decision_id: 'pdr_11111111111111111111111111111111',
  trace_id: 'trc_11111111111111111111111111111111',
  action_id: 'act_11111111111111111111111111111111',
});

const entry = Object.freeze({
  seq: 42,
  ts: Date.parse('2026-09-08T12:00:00Z'),
  hash: 'a'.repeat(64),
  payload: Object.freeze({
    type: 'policy.action.admitted',
    tenant: correlation.tenant_id,
    data: { tool: 'repo.patch', decision: 'allow' },
  }),
});

test('platform-event-ref: projects native TG audit without replacing payload', () => {
  const projected = projectPlatformEventRef(entry, {
    subjectRef: 'tool:repo.patch',
    correlation,
  });

  assert.equal(projected.schema, 'platform-event-ref/0.1');
  assert.equal(projected.source, 'trust-gateway');
  assert.equal(projected.event_type, 'policy.action.admitted');
  assert.equal(projected.occurred_at, '2026-09-08T12:00:00.000Z');
  assert.equal(projected.subject_ref, 'tool:repo.patch');
  assert.deepEqual(projected.correlation, correlation);
  assert.equal(projected.payload_ref, 'tg:audit:42');
  assert.equal(projected.integrity_ref, `sha256:${'a'.repeat(64)}`);
  assert.equal(projected.classification, 'enforcement');
  assert.match(projected.event_id, /^evt_[a-f0-9]{32}$/u);
  assert.equal(Object.hasOwn(projected, 'data'), false);
  assert.equal(Object.hasOwn(projected, 'authority'), false);
  assert.equal(Object.hasOwn(projected, 'authority_grant'), false);
});

test('platform-event-ref: event identity is deterministic for the sealed native entry', () => {
  const first = projectPlatformEventRef(entry, { subjectRef: 'tool:repo.patch', correlation });
  const second = projectPlatformEventRef(entry, { subjectRef: 'tool:repo.patch', correlation });
  assert.equal(first.event_id, second.event_id);
});

test('platform-event-ref: fails closed on tenant drift', () => {
  assert.throws(
    () =>
      projectPlatformEventRef(entry, {
        subjectRef: 'tool:repo.patch',
        correlation: {
          ...correlation,
          tenant_id: 'ten_22222222222222222222222222222222',
        },
      }),
    /native audit tenant does not match canonical tenant_id/u,
  );
});

test('platform-event-ref: action identity is mandatory', () => {
  const { action_id: _actionId, ...missingAction } = correlation;
  assert.throws(
    () => projectPlatformEventRef(entry, { subjectRef: 'tool:repo.patch', correlation: missingAction }),
    /missing correlation field: action_id/u,
  );
});

test('platform-event-ref: correlation cannot smuggle authority fields', () => {
  assert.throws(
    () =>
      projectPlatformEventRef(entry, {
        subjectRef: 'tool:repo.patch',
        correlation: { ...correlation, authority_grant: 'admin' },
      }),
    /unexpected correlation field: authority_grant/u,
  );
});

test('platform-event-ref: malformed native integrity is rejected', () => {
  assert.throws(
    () =>
      projectPlatformEventRef(
        { ...entry, hash: 'not-a-sealed-chain-hash' },
        { subjectRef: 'tool:repo.patch', correlation },
      ),
    /invalid audit hash/u,
  );
});
