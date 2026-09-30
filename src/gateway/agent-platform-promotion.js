'use strict';

const HEX64 = /^[a-f0-9]{64}$/i;

function evaluatePromotionRequest(input = {}) {
  const reasons = [];
  const decision = input.decision || {};
  const evidence = input.evidence || {};

  if (decision.decision !== 'ACCEPT') reasons.push('decision_not_accept');
  if (!HEX64.test(String(decision.evidenceHash || evidence.evidenceDigest || ''))) reasons.push('missing_or_invalid_evidence_hash');
  if (!Array.isArray(decision.evaluators) || new Set(decision.evaluators).size < 2) reasons.push('insufficient_independent_evaluators');
  if (evidence.authorityGranted === true || evidence.promotionGranted === true) reasons.push('evaluator_claimed_authority');
  if (Array.isArray(evidence.regressions) && evidence.regressions.length > 0) reasons.push('regressions_present');
  if (Array.isArray(evidence.adversarialFailures) && evidence.adversarialFailures.length > 0) reasons.push('adversarial_failures_present');
  if (input.auditIntegrity !== true) reasons.push('audit_integrity_not_proven');
  if (!input.candidate || typeof input.candidate !== 'object') reasons.push('missing_candidate');

  const humanReviewRequired = input.humanReviewRequired === true;
  if (humanReviewRequired) reasons.push('human_review_required');

  return Object.freeze({
    contract: 'aftergraph.promotion-check/v1',
    eligible: reasons.length === 0,
    decision: reasons.length === 0 ? 'ELIGIBLE' : humanReviewRequired ? 'HUMAN_REVIEW' : 'DENY',
    reasons,
    capabilityRequired: 'canonical.promote',
    authorityGranted: false
  });
}

module.exports = { evaluatePromotionRequest };
