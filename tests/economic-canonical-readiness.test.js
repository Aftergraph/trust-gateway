'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateEconomicSigningBoundary } = require('../src/gateway/economic-signing-boundary');
const { evaluateEconomicCustodyBoundary } = require('../src/gateway/economic-custody-boundary');

const validSigner = {
  lifecycle: 'candidate',
  mode: 'prepare',
  requestDigest: 'sha256:' + 'a'.repeat(64),
  keyHandle: 'keyref_external_hsm_01',
  authorityLeaseId: 'auth_1234567890123456',
  approvalProofId: 'apr_1234567890123456',
  now: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
  externalEffects: 0
};

test('candidate signing boundary prepares without producing a signature', () => {
  const out = evaluateEconomicSigningBoundary(validSigner);
  assert.equal(out.allowed, true);
  assert.equal(out.decision, 'PREPARED');
  assert.equal(out.signatureProduced, false);
  assert.equal(out.signingMaterialExposed, false);
  assert.equal(out.canBroadcast, false);
  assert.equal(out.externalEffects, 0);
});

test('signing boundary rejects missing human approval', () => {
  const out = evaluateEconomicSigningBoundary({ ...validSigner, approvalProofId: '' });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'economic_signing_human_approval_missing');
});

test('signing boundary rejects expired or effect-capable requests', () => {
  assert.equal(evaluateEconomicSigningBoundary({ ...validSigner, expiresAt: validSigner.now }).allowed, false);
  assert.equal(evaluateEconomicSigningBoundary({ ...validSigner, externalEffects: 1 }).allowed, false);
});

test('signing boundary cannot execute or broadcast', () => {
  const out = evaluateEconomicSigningBoundary({ ...validSigner, mode: 'execute' });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'economic_signing_prepare_only');
});

test('custody boundary verifies references only', () => {
  const out = evaluateEconomicCustodyBoundary({
    lifecycle: 'candidate',
    mode: 'verify-reference',
    custodyRef: 'cust_external_custodian_01',
    recoveryPolicyRef: 'rec_two_person_recovery_01',
    externalEffects: 0
  });
  assert.equal(out.allowed, true);
  assert.equal(out.decision, 'VERIFIED_REFERENCE_ONLY');
  assert.equal(out.canMoveAssets, false);
  assert.equal(out.canRecoverAssets, false);
  assert.equal(out.liveCustodyApiCalled, false);
});

test('custody boundary rejects live-effect requests', () => {
  const out = evaluateEconomicCustodyBoundary({
    lifecycle: 'candidate',
    mode: 'verify-reference',
    custodyRef: 'cust_external_custodian_01',
    recoveryPolicyRef: 'rec_two_person_recovery_01',
    externalEffects: 1
  });
  assert.equal(out.allowed, false);
});
