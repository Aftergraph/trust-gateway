'use strict';

const HEX64 = /^[a-f0-9]{64}$/i;

function validateExecutionProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['execution_provenance_required'];
  }
  const reasons = [];
  for (const key of ['routingDecisionHash', 'branchHash', 'lineageHash', 'worksEvidenceHash']) {
    if (!HEX64.test(String(value[key] || ''))) reasons.push(`invalid_${key}`);
  }
  if (!String(value.branchId || '').trim()) reasons.push('branch_id_required');
  if (!String(value.workId || '').trim()) reasons.push('work_id_required');
  if (!/^sge_[a-f0-9]{64}$/i.test(String(value.sentinelEvidenceId || ''))) {
    reasons.push('sentinel_evidence_id_required');
  }
  return reasons;
}

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

  const requireExecutionProvenance = input.requireExecutionProvenance === true;
  const executionProvenance = input.executionProvenance || null;
  if (requireExecutionProvenance || executionProvenance !== null) {
    reasons.push(...validateExecutionProvenance(executionProvenance));
    if (executionProvenance && HEX64.test(String(decision.evidenceHash || '')) &&
        String(executionProvenance.worksEvidenceHash || '') !== String(decision.evidenceHash)) {
      reasons.push('works_evidence_hash_mismatch');
    }
  }

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
