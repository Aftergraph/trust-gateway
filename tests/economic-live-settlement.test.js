'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEconomicLiveSettlement } = require('../src/gateway/economic-live-settlement');

test('non-canonical live settlement allows only zero-effect simulation', () => {
  assert.deepEqual(
    evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'frontier', externalEffects: 0 }),
    {
      allowed: true,
      decision: 'ALLOW_SIMULATION_ONLY',
      reason: 'economic_live_settlement_noncanonical_simulation',
      externalEffects: 0
    }
  );
});

test('frontier live settlement rejects any requested external effect', () => {
  const out = evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'frontier', externalEffects: 1 });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'frontier_simulation_requires_zero_effects');
});

test('live execution fails closed for both frontier and candidate lifecycles', () => {
  for (const lifecycle of ['frontier', 'candidate']) {
    const out = evaluateEconomicLiveSettlement({
      mode: 'execute',
      lifecycle,
      gateRef: 'caller-supplied-pass',
      registryRef: 'caller-supplied-pass'
    });
    assert.equal(out.allowed, false);
    assert.equal(out.decision, 'DENY');
    assert.equal(out.reason, 'economic_live_settlement_not_canonical');
  }
});

test('candidate live settlement simulation remains zero-effect only', () => {
  const ok = evaluateEconomicLiveSettlement({
    mode: 'simulate',
    lifecycle: 'candidate',
    externalEffects: 0
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.decision, 'ALLOW_SIMULATION_ONLY');
  assert.equal(ok.reason, 'economic_live_settlement_noncanonical_simulation');
  assert.equal(ok.externalEffects, 0);

  const denied = evaluateEconomicLiveSettlement({
    mode: 'simulate',
    lifecycle: 'candidate',
    externalEffects: 1
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.decision, 'DENY');
});

test('experimental custody/spend-style lifecycle is ineligible', () => {
  const out = evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'experimental' });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'economic_lifecycle_not_eligible');
});


test('live-canary review assurance never grants execution to candidate settlement', () => {
  const out = evaluateEconomicLiveSettlement({
    mode: 'execute',
    lifecycle: 'candidate',
    externalEffects: 0,
    assurance: {
      schema: 'aftergraph.economic-live-canary-assurance/v1',
      state: 'READY_FOR_LIVE_CANARY_REVIEW',
      readyForLiveCanaryReview: true,
      executionAuthority: false,
      liveValueEnabled: false,
      maxLiveValue: 0,
      final: false,
      promotionAuthority: false,
      externalEffects: 0
    }
  });
  assert.equal(out.allowed, false);
  assert.equal(out.decision, 'DENY');
  assert.equal(out.reason, 'economic_live_settlement_not_canonical');
});


test('verified immutable evidence pack never grants execution to candidate settlement', () => {
  const out = evaluateEconomicLiveSettlement({
    mode: 'execute',
    lifecycle: 'candidate',
    externalEffects: 0,
    evidencePackVerification: {
      schema: 'aftergraph.economic-evidence-pack-verification/v1',
      valid: true,
      state: 'VERIFIED_IMMUTABLE_EVIDENCE_PACK',
      evidencePackVerified: true,
      readyForLiveCanaryReview: true,
      executionAuthority: false,
      liveValueEnabled: false,
      maxLiveValue: 0,
      final: false,
      promotionAuthority: false,
      externalEffects: 0,
      reasons: []
    }
  });
  assert.equal(out.allowed, false);
  assert.equal(out.decision, 'DENY');
  assert.equal(out.reason, 'economic_live_settlement_not_canonical');
});
