'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createPublicKey, createHash, sign } = require('node:crypto');
const {
  prepareEconomicSignerCanary,
  validateEconomicSignerCanaryReceipt
} = require('../src/gateway/economic-signer-canary');

function fingerprint(publicKey) {
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return 'sha256:' + createHash('sha256').update(der).digest('hex');
}

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const request = prepareEconomicSignerCanary({
    nonce: 'canary_1234567890123456',
    authorityLeaseId: 'auth_1234567890123456',
    approvalProofId: 'apr_1234567890123456',
    keyHandle: 'keyref_ephemeral_hsm_canary_01',
    publicKeyFingerprint: fingerprint(publicKey),
    expiresAt: 1_900_000_000_000,
    externalEffects: 0
  });
  const sig = sign(null, Buffer.from(request.challengeDigest), privateKey);
  const receipt = {
    schema: 'aftergraph.external-signer-receipt/v1',
    challengeDigest: request.challengeDigest,
    keyHandle: request.payload.keyHandle,
    publicKeyFingerprint: request.payload.publicKeyFingerprint,
    algorithm: 'Ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signatureBase64: sig.toString('base64'),
    signingMaterialExposed: false,
    transactionPayloadSigned: false,
    canBroadcast: false,
    externalEffects: 0
  };
  return { request, receipt, publicKey };
}

test('prepares a domain-separated non-economic challenge only', () => {
  const { request } = fixture();
  assert.equal(request.payload.purpose, 'NON_ECONOMIC_CANARY');
  assert.equal(request.transactionPayloadPresent, false);
  assert.equal(request.canBroadcast, false);
  assert.equal(request.externalEffects, 0);
  assert.match(request.challengeDigest, /^sha256:[a-f0-9]{64}$/);
});

test('forbids transaction bytes or raw payloads', () => {
  assert.throws(() => prepareEconomicSignerCanary({
    transactionBytes: '0xdeadbeef',
    nonce: 'canary_1234567890123456'
  }), /TRANSACTION_PAYLOAD_FORBIDDEN/);
});

test('accepts receipt shape but requires independent crypto verification', () => {
  const { request, receipt } = fixture();
  const out = validateEconomicSignerCanaryReceipt(request, receipt, 1_800_000_000_000);
  assert.equal(out.valid, true);
  assert.equal(out.cryptographicVerificationRequired, true);
  assert.equal(out.promotionAuthority, false);
});

test('rejects mismatched key binding and any boundary overclaim', () => {
  const { request, receipt } = fixture();
  assert.equal(validateEconomicSignerCanaryReceipt(request, { ...receipt, keyHandle: 'keyref_other_123456789012' }, 1_800_000_000_000).valid, false);
  assert.equal(validateEconomicSignerCanaryReceipt(request, { ...receipt, canBroadcast: true }, 1_800_000_000_000).valid, false);
  assert.equal(validateEconomicSignerCanaryReceipt(request, { ...receipt, signingMaterialExposed: true }, 1_800_000_000_000).valid, false);
  assert.equal(validateEconomicSignerCanaryReceipt(request, { ...receipt, transactionPayloadSigned: true }, 1_800_000_000_000).valid, false);
  assert.equal(validateEconomicSignerCanaryReceipt(request, { ...receipt, externalEffects: 1 }, 1_800_000_000_000).valid, false);
});
