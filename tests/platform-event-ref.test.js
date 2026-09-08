'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { entryHash } = require('../src/gateway/hash-chain');
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

const tenantBinding = Object.freeze({
  local_tenant_id: 'acme',
  tenant_id: correlation.tenant_id,
});

function sealEntry(overrides = {}) {
  const base = {
    seq: 42,
    prevHash: '0'.repeat(64),
    ts: Date.parse('2026-09-08T12:00:00Z'),
    payload: {
      type: 'policy.action.admitted',
      tenant: tenantBinding.local_tenant_id,
      data: { tool: 'repo.patch', decision: 'allow' },
    },
    ...overrides,
  };
  return Object.freeze({
    ...base,
    payload: Object.freeze(base.payload),
    hash: entryHash(base.seq, base.prevHash, base.ts, base.payload),
  });
}

const entry = sealEntry();

const projectionOptions = Object.freeze({
  subjectRef: 'tool:repo.patch',
  correlation,
  tenantBinding,
});

test('platform-event-ref: projects a cryptographically valid native TG audit entry', () => {
  const projected = projectPlatformEventRef(entry, projectionOptions);

  assert.equal(projected.schema, 'platform-event-ref/0.1');
  assert.equal(projected.source, 'trust-gateway');
  assert.equal(projected.event_type, 'policy.action.admitted');
  assert.equal(projected.occurred_at, '2026-09-08T12:00:00.000Z');
  assert.equal(projected.subject_ref, 'tool:repo.patch');
  assert.deepEqual(projected.correlation, correlation);
  assert.equal(projected.payload_ref, 'tg:audit:42');
  assert.equal(projected.integrity_ref, `sha256:${entry.hash}`);
  assert.equal(projected.classification, 'enforcement');
  assert.match(projected.event_id, /^evt_[a-f0-9]{32}$/u);
  assert.equal(Object.hasOwn(projected, 'data'), false);
  assert.equal(Object.hasOwn(projected, 'authority'), false);
  assert.equal(Object.hasOwn(projected, 'authority_grant'), false);
});

test('platform-event-ref: event identity is deterministic for the sealed native entry', () => {
  const first = projectPlatformEventRef(entry, projectionOptions);
  const second = projectPlatformEventRef(entry, projectionOptions);
  assert.equal(first.event_id, second.event_id);
});

test('platform-event-ref: rejects payload tampering under a retained native hash', () => {
  const forged = {
    ...entry,
    payload: {
      ...entry.payload,
      type: 'policy.action.allowed_without_review',
    },
  };
  assert.throws(
    () => projectPlatformEventRef(forged, projectionOptions),
    /native audit hash mismatch/u,
  );
});

test('platform-event-ref: rejects sequence/timestamp/prev-hash tampering under retained hash', () => {
  for (const forged of [
    { ...entry, seq: entry.seq + 1 },
    { ...entry, ts: entry.ts + 1 },
    { ...entry, prevHash: 'b'.repeat(64) },
  ]) {
    assert.throws(
      () => projectPlatformEventRef(forged, projectionOptions),
      /native audit hash mismatch/u,
    );
  }
});

test('platform-event-ref: canonical tenant must match the supplied durable binding', () => {
  assert.throws(
    () =>
      projectPlatformEventRef(entry, {
        ...projectionOptions,
        correlation: {
          ...correlation,
          tenant_id: 'ten_22222222222222222222222222222222',
        },
      }),
    /canonical tenant does not match tenant binding/u,
  );
});

test('platform-event-ref: local audit tenant must match the supplied durable binding', () => {
  const wrongLocal = sealEntry({
    payload: {
      ...entry.payload,
      tenant: 'other-tenant',
    },
  });
  assert.throws(
    () => projectPlatformEventRef(wrongLocal, projectionOptions),
    /native audit tenant does not match tenant binding/u,
  );
});

test('platform-event-ref: main tenant rows still require an explicit canonical binding', () => {
  const mainEntry = sealEntry({
    payload: {
      type: 'policy.action.admitted',
      data: { tool: 'repo.patch', decision: 'allow' },
    },
  });
  const mainBinding = {
    local_tenant_id: 'main',
    tenant_id: correlation.tenant_id,
  };
  const projected = projectPlatformEventRef(mainEntry, {
    subjectRef: 'tool:repo.patch',
    correlation,
    tenantBinding: mainBinding,
  });
  assert.equal(projected.correlation.tenant_id, correlation.tenant_id);

  assert.throws(
    () =>
      projectPlatformEventRef(mainEntry, {
        subjectRef: 'tool:repo.patch',
        correlation,
      }),
    /tenant binding is required/u,
  );
});

test('platform-event-ref: action identity is mandatory', () => {
  const { action_id: _actionId, ...missingAction } = correlation;
  assert.throws(
    () =>
      projectPlatformEventRef(entry, {
        ...projectionOptions,
        correlation: missingAction,
      }),
    /missing correlation field: action_id/u,
  );
});

test('platform-event-ref: correlation cannot smuggle authority fields', () => {
  assert.throws(
    () =>
      projectPlatformEventRef(entry, {
        ...projectionOptions,
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
        projectionOptions,
      ),
    /invalid audit hash/u,
  );
});
