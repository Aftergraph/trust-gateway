'use strict';

const ALLOWED_LIFECYCLES = new Set(['frontier', 'candidate', 'canonical']);

function evaluateEconomicLiveSettlement(input = {}) {
  const mode = String(input.mode || '').toLowerCase();
  const lifecycle = String(input.lifecycle || '').toLowerCase();
  const requestedExternalEffects = Number(input.externalEffects || 0);

  if (!ALLOWED_LIFECYCLES.has(lifecycle)) {
    return { allowed: false, decision: 'DENY', reason: 'economic_lifecycle_not_eligible' };
  }

  if (mode === 'simulate') {
    if (requestedExternalEffects !== 0) {
      return { allowed: false, decision: 'DENY', reason: 'frontier_simulation_requires_zero_effects' };
    }
    return {
      allowed: true,
      decision: 'ALLOW_SIMULATION_ONLY',
      reason: 'economic_live_settlement_frontier_simulation',
      externalEffects: 0
    };
  }

  // Current governance truth: live settlement remains FRONTIER. This seam must
  // fail closed until Trust Gateway consumes governance-owned promotion evidence
  // proving the capability itself is CANONICAL. Caller-supplied refs never count.
  return {
    allowed: false,
    decision: 'DENY',
    reason: 'economic_live_settlement_not_canonical',
    requires: [
      'governance_owned_canonical_capability_record',
      'independent_verification',
      'action_time_authority_readmission'
    ]
  };
}

module.exports = { evaluateEconomicLiveSettlement };
