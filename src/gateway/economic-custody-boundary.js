'use strict';

function evaluateEconomicCustodyBoundary(input = {}) {
  const mode = String(input.mode || '').toLowerCase();
  const lifecycle = String(input.lifecycle || '').toLowerCase();
  const custodyRef = String(input.custodyRef || '');
  const recoveryPolicyRef = String(input.recoveryPolicyRef || '');
  const externalEffects = Number(input.externalEffects || 0);

  const base = {
    schema: 'aftergraph.economic-custody-boundary-decision/v1',
    custodyMaterialExposed: false,
    externalEffects: 0
  };

  if (externalEffects !== 0) return { ...base, decision: 'DENY', allowed: false, reason: 'custody_boundary_requires_zero_effects' };
  if (!['candidate','canonical'].includes(lifecycle)) return { ...base, decision: 'DENY', allowed: false, reason: 'economic_custody_lifecycle_ineligible' };
  if (mode !== 'verify-reference') return { ...base, decision: 'DENY', allowed: false, reason: 'economic_custody_reference_verification_only' };
  if (!/^cust_[a-zA-Z0-9_-]{12,}$/.test(custodyRef)) return { ...base, decision: 'DENY', allowed: false, reason: 'economic_custody_reference_invalid' };
  if (!/^rec_[a-zA-Z0-9_-]{12,}$/.test(recoveryPolicyRef)) return { ...base, decision: 'DENY', allowed: false, reason: 'economic_recovery_policy_missing' };

  return {
    ...base,
    decision: 'VERIFIED_REFERENCE_ONLY',
    allowed: true,
    reason: 'economic_custody_reference_verified',
    custodyRef,
    recoveryPolicyRef,
    canMoveAssets: false,
    canRecoverAssets: false,
    liveCustodyApiCalled: false
  };
}

module.exports = { evaluateEconomicCustodyBoundary };
