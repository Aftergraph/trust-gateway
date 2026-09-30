'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEconomicLiveSettlement } = require('../src/gateway/economic-live-settlement');

test('frontier live settlement allows only zero-effect simulation', () => {
  assert.deepEqual(
    evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'frontier', externalEffects: 0 }),
    {
      allowed: true,
      decision: 'ALLOW_SIMULATION_ONLY',
      reason: 'economic_live_settlement_frontier_simulation',
      externalEffects: 0
    }
  );
});

test('frontier live settlement rejects any requested external effect', () => {
  const out = evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'frontier', externalEffects: 1 });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'frontier_simulation_requires_zero_effects');
});

test('live execution fails closed while capability is not canonical', () => {
  const out = evaluateEconomicLiveSettlement({
    mode: 'execute',
    lifecycle: 'frontier',
    gateRef: 'caller-supplied-pass',
    registryRef: 'caller-supplied-pass'
  });
  assert.equal(out.allowed, false);
  assert.equal(out.decision, 'DENY');
  assert.equal(out.reason, 'economic_live_settlement_not_canonical');
});

test('experimental custody/spend-style lifecycle is ineligible', () => {
  const out = evaluateEconomicLiveSettlement({ mode: 'simulate', lifecycle: 'experimental' });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'economic_lifecycle_not_eligible');
});
