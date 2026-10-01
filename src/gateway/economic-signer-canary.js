'use strict';

const { createHash } = require('node:crypto');

const DOMAIN = 'aftergraph/economic-signer-canary/v1';

function canonicalCanaryPayload(input = {}) {
  const nonce = String(input.nonce || '');
  const authorityLeaseId = String(input.authorityLeaseId || '');
  const approvalProofId = String(input.approvalProofId || '');
  const keyHandle = String(input.keyHandle || '');
  const publicKeyFingerprint = String(input.publicKeyFingerprint || '').toLowerCase();
  const expiresAt = Number(input.expiresAt || 0);

  if (!/^canary_[a-zA-Z0-9_-]{12,}$/.test(nonce)) throw new Error('SIGNER_CANARY_NONCE_INVALID');
  if (!/^auth_[a-zA-Z0-9_-]{12,}$/.test(authorityLeaseId)) throw new Error('SIGNER_CANARY_AUTHORITY_INVALID');
  if (!/^apr_[a-zA-Z0-9_-]{12,}$/.test(approvalProofId)) throw new Error('SIGNER_CANARY_APPROVAL_INVALID');
  if (!/^keyref_[a-zA-Z0-9_-]{12,}$/.test(keyHandle)) throw new Error('SIGNER_CANARY_KEY_HANDLE_INVALID');
  if (!/^sha256:[a-f0-9]{64}$/.test(publicKeyFingerprint)) throw new Error('SIGNER_CANARY_PUBLIC_KEY_FINGERPRINT_INVALID');
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('SIGNER_CANARY_EXPIRY_INVALID');

  return {
    domain: DOMAIN,
    purpose: 'NON_ECONOMIC_CANARY',
    nonce,
    authorityLeaseId,
    approvalProofId,
    keyHandle,
    publicKeyFingerprint,
    expiresAt
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function prepareEconomicSignerCanary(input = {}) {
  if (input.transactionBytes !== undefined || input.transaction !== undefined || input.rawPayload !== undefined) {
    throw new Error('SIGNER_CANARY_TRANSACTION_PAYLOAD_FORBIDDEN');
  }
  if (Number(input.externalEffects || 0) !== 0) {
    throw new Error('SIGNER_CANARY_REQUIRES_ZERO_EFFECTS');
  }
  const payload = canonicalCanaryPayload(input);
  const payloadJson = canonicalJson(payload);
  const challengeDigest = 'sha256:' + createHash('sha256').update(payloadJson).digest('hex');
  return {
    schema: 'aftergraph.economic-signer-canary-request/v1',
    payload,
    challengeDigest,
    algorithm: 'Ed25519',
    signatureRequested: true,
    transactionPayloadPresent: false,
    canBroadcast: false,
    externalEffects: 0
  };
}

function validateEconomicSignerCanaryReceipt(request, receipt = {}, now = Date.now()) {
  if (request?.schema !== 'aftergraph.economic-signer-canary-request/v1') {
    return { valid: false, reason: 'SIGNER_CANARY_REQUEST_SCHEMA_INVALID' };
  }
  if (receipt?.schema !== 'aftergraph.external-signer-receipt/v1') {
    return { valid: false, reason: 'SIGNER_CANARY_RECEIPT_SCHEMA_INVALID' };
  }
  if (request.payload?.expiresAt <= now) {
    return { valid: false, reason: 'SIGNER_CANARY_EXPIRED' };
  }
  if (receipt.challengeDigest !== request.challengeDigest) {
    return { valid: false, reason: 'SIGNER_CANARY_DIGEST_MISMATCH' };
  }
  if (receipt.keyHandle !== request.payload.keyHandle) {
    return { valid: false, reason: 'SIGNER_CANARY_KEY_HANDLE_MISMATCH' };
  }
  if (String(receipt.publicKeyFingerprint || '').toLowerCase() !== request.payload.publicKeyFingerprint) {
    return { valid: false, reason: 'SIGNER_CANARY_PUBLIC_KEY_FINGERPRINT_MISMATCH' };
  }
  if (receipt.algorithm !== 'Ed25519') {
    return { valid: false, reason: 'SIGNER_CANARY_ALGORITHM_INVALID' };
  }
  if (typeof receipt.publicKeyPem !== 'string' || !receipt.publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    return { valid: false, reason: 'SIGNER_CANARY_PUBLIC_KEY_MISSING' };
  }
  if (receipt.signingMaterialExposed !== false || receipt.transactionPayloadSigned !== false || receipt.canBroadcast !== false) {
    return { valid: false, reason: 'SIGNER_CANARY_BOUNDARY_VIOLATION' };
  }
  if (receipt.externalEffects !== 0) {
    return { valid: false, reason: 'SIGNER_CANARY_EXTERNAL_EFFECT' };
  }
  if (typeof receipt.signatureBase64 !== 'string' || receipt.signatureBase64.length < 40) {
    return { valid: false, reason: 'SIGNER_CANARY_SIGNATURE_MISSING' };
  }
  return {
    valid: true,
    state: 'RECEIPT_SHAPE_ACCEPTED',
    cryptographicVerificationRequired: true,
    promotionAuthority: false,
    canBroadcast: false,
    externalEffects: 0
  };
}

module.exports = {
  ECONOMIC_SIGNER_CANARY_DOMAIN: DOMAIN,
  canonicalCanaryPayload,
  prepareEconomicSignerCanary,
  validateEconomicSignerCanaryReceipt
};
