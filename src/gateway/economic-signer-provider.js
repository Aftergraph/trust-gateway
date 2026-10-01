'use strict';

const { createHash, createPublicKey } = require('node:crypto');
const { validateEconomicSignerCanaryReceipt } = require('./economic-signer-canary');

function fingerprintPublicKey(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return 'sha256:' + createHash('sha256').update(der).digest('hex');
}

class OpaqueSignerProvider {
  #providerId;
  #signDigest;
  #keys = new Map();
  #usedDigests = new Set();

  constructor({ providerId, signDigest }) {
    if (!/^signer_[a-zA-Z0-9_-]{8,}$/.test(String(providerId || ''))) {
      throw new Error('SIGNER_PROVIDER_ID_INVALID');
    }
    if (typeof signDigest !== 'function') throw new Error('SIGNER_PROVIDER_CALLBACK_REQUIRED');
    this.#providerId = providerId;
    this.#signDigest = signDigest;
  }

  registerKey({ keyHandle, publicKeyPem, generation = 1, previousKeyFingerprint = null }) {
    if (!/^keyref_[a-zA-Z0-9_-]{12,}$/.test(String(keyHandle || ''))) throw new Error('SIGNER_PROVIDER_KEY_HANDLE_INVALID');
    if (!Number.isInteger(generation) || generation < 1) throw new Error('SIGNER_PROVIDER_GENERATION_INVALID');
    if (this.#keys.has(keyHandle)) throw new Error('SIGNER_PROVIDER_KEY_ALREADY_EXISTS');
    const publicKeyFingerprint = fingerprintPublicKey(publicKeyPem);
    const record = {
      keyHandle,
      publicKeyPem,
      publicKeyFingerprint,
      generation,
      previousKeyFingerprint,
      state: 'ACTIVE'
    };
    this.#keys.set(keyHandle, record);
    return { ...record };
  }

  rotateKey(oldKeyHandle, next) {
    const old = this.#keys.get(oldKeyHandle);
    if (!old || old.state !== 'ACTIVE') throw new Error('SIGNER_PROVIDER_ROTATION_SOURCE_NOT_ACTIVE');
    if (next.generation !== old.generation + 1) throw new Error('SIGNER_PROVIDER_ROTATION_GENERATION_INVALID');
    const registered = this.registerKey({
      ...next,
      previousKeyFingerprint: old.publicKeyFingerprint
    });
    old.state = 'RETIRED';
    return {
      schema: 'aftergraph.signer-key-rotation/v1',
      providerId: this.#providerId,
      oldKeyHandle,
      oldKeyFingerprint: old.publicKeyFingerprint,
      oldGeneration: old.generation,
      newKeyHandle: registered.keyHandle,
      newKeyFingerprint: registered.publicKeyFingerprint,
      newGeneration: registered.generation,
      oldState: old.state,
      newState: registered.state,
      privateKeyMaterialTransferred: false,
      externalEffects: 0
    };
  }

  revokeKey(keyHandle, reason = 'operator_revocation') {
    const key = this.#keys.get(keyHandle);
    if (!key) throw new Error('SIGNER_PROVIDER_KEY_NOT_FOUND');
    if (key.state === 'REVOKED') throw new Error('SIGNER_PROVIDER_KEY_ALREADY_REVOKED');
    key.state = 'REVOKED';
    return {
      schema: 'aftergraph.signer-key-revocation/v1',
      providerId: this.#providerId,
      keyHandle,
      publicKeyFingerprint: key.publicKeyFingerprint,
      generation: key.generation,
      reason,
      state: 'REVOKED',
      externalEffects: 0
    };
  }

  keyStatus(keyHandle) {
    const key = this.#keys.get(keyHandle);
    if (!key) return null;
    return {
      keyHandle: key.keyHandle,
      publicKeyFingerprint: key.publicKeyFingerprint,
      generation: key.generation,
      previousKeyFingerprint: key.previousKeyFingerprint,
      state: key.state
    };
  }

  async signCanary(request, now = Date.now()) {
    if (request?.schema !== 'aftergraph.economic-signer-canary-request/v1') throw new Error('SIGNER_PROVIDER_REQUEST_SCHEMA_INVALID');
    if (request?.payload?.purpose !== 'NON_ECONOMIC_CANARY') throw new Error('SIGNER_PROVIDER_PURPOSE_FORBIDDEN');
    if (request?.transactionPayloadPresent !== false || request?.canBroadcast !== false || request?.externalEffects !== 0) {
      throw new Error('SIGNER_PROVIDER_EFFECT_BOUNDARY_VIOLATION');
    }
    if (request.payload.expiresAt <= now) throw new Error('SIGNER_PROVIDER_REQUEST_EXPIRED');
    if (this.#usedDigests.has(request.challengeDigest)) throw new Error('SIGNER_PROVIDER_REPLAY_REJECTED');

    const key = this.#keys.get(request.payload.keyHandle);
    if (!key || key.state !== 'ACTIVE') throw new Error('SIGNER_PROVIDER_KEY_NOT_ACTIVE');
    if (key.publicKeyFingerprint !== request.payload.publicKeyFingerprint) throw new Error('SIGNER_PROVIDER_FINGERPRINT_MISMATCH');

    const result = await this.#signDigest({
      providerId: this.#providerId,
      keyHandle: key.keyHandle,
      challengeDigest: request.challengeDigest,
      algorithm: 'Ed25519',
      purpose: 'NON_ECONOMIC_CANARY'
    });
    if (!result || typeof result.signatureBase64 !== 'string') throw new Error('SIGNER_PROVIDER_SIGNATURE_MISSING');

    const receipt = {
      schema: 'aftergraph.external-signer-receipt/v1',
      providerId: this.#providerId,
      challengeDigest: request.challengeDigest,
      keyHandle: key.keyHandle,
      keyGeneration: key.generation,
      keyStateAtSigning: key.state,
      publicKeyFingerprint: key.publicKeyFingerprint,
      publicKeyPem: key.publicKeyPem,
      algorithm: 'Ed25519',
      signatureBase64: result.signatureBase64,
      signingMaterialExposed: false,
      transactionPayloadSigned: false,
      canBroadcast: false,
      externalEffects: 0
    };

    const shape = validateEconomicSignerCanaryReceipt(request, receipt, now);
    if (!shape.valid) throw new Error('SIGNER_PROVIDER_RECEIPT_SHAPE_INVALID:' + shape.reason);
    this.#usedDigests.add(request.challengeDigest);
    return receipt;
  }
}

module.exports = { OpaqueSignerProvider, fingerprintPublicKey };
