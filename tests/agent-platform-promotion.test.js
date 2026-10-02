'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePromotionRequest } = require('../src/gateway/agent-platform-promotion');

const accepted = {
  decision: {
    decision: 'ACCEPT',
    evidenceHash: 'a'.repeat(64),
    evaluators: ['eval-a', 'eval-b']
  },
  evidence: {
    regressions: [],
    adversarialFailures: [],
    authorityGranted: false,
    promotionGranted: false
  },
  candidate: { id: 'candidate-1' },
  auditIntegrity: true
};

test('promotion preflight marks independently evidenced ACCEPT as eligible but grants no authority', () => {
  const result = evaluatePromotionRequest(accepted);
  assert.equal(result.eligible, true);
  assert.equal(result.decision, 'ELIGIBLE');
  assert.equal(result.authorityGranted, false);
  assert.equal(result.capabilityRequired, 'canonical.promote');
});

test('promotion preflight fails closed on self-certification or missing audit proof', () => {
  const result = evaluatePromotionRequest({
    ...accepted,
    decision: { ...accepted.decision, evaluators: ['same-evaluator', 'same-evaluator'] },
    evidence: { ...accepted.evidence, promotionGranted: true },
    auditIntegrity: false
  });
  assert.equal(result.eligible, false);
  assert.equal(result.decision, 'DENY');
  assert.ok(result.reasons.includes('insufficient_independent_evaluators'));
  assert.ok(result.reasons.includes('evaluator_claimed_authority'));
  assert.ok(result.reasons.includes('audit_integrity_not_proven'));
});

test('human-review policy cannot be bypassed by ACCEPT evidence', () => {
  const result = evaluatePromotionRequest({ ...accepted, humanReviewRequired: true });
  assert.equal(result.eligible, false);
  assert.equal(result.decision, 'HUMAN_REVIEW');
});


test('promotion preflight binds execution provenance when policy requires it', () => {
  const evidenceHash = 'd'.repeat(64);
  const result = evaluatePromotionRequest({
    ...accepted,
    decision: { ...accepted.decision, evidenceHash },
    requireExecutionProvenance: true,
    executionProvenance: {
      routingDecisionHash: '1'.repeat(64),
      branchId: 'branch-a',
      branchHash: '2'.repeat(64),
      lineageHash: '3'.repeat(64),
      workId: 'work-1',
      worksEvidenceHash: evidenceHash,
      sentinelEvidenceId: 'sge_' + '4'.repeat(64)
    }
  });
  assert.equal(result.eligible, true);
  assert.equal(result.decision, 'ELIGIBLE');
});

test('promotion preflight fails closed on missing or mismatched execution provenance', () => {
  const missing = evaluatePromotionRequest({
    ...accepted,
    requireExecutionProvenance: true
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.reasons.includes('execution_provenance_required'));

  const mismatch = evaluatePromotionRequest({
    ...accepted,
    requireExecutionProvenance: true,
    executionProvenance: {
      routingDecisionHash: '1'.repeat(64),
      branchId: 'branch-a',
      branchHash: '2'.repeat(64),
      lineageHash: '3'.repeat(64),
      workId: 'work-1',
      worksEvidenceHash: 'f'.repeat(64),
      sentinelEvidenceId: 'sge_' + '4'.repeat(64)
    }
  });
  assert.equal(mismatch.eligible, false);
  assert.ok(mismatch.reasons.includes('works_evidence_hash_mismatch'));
});
