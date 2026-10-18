'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { prepareEconomicSignerCanary } = require('../src/gateway/economic-signer-canary');
const { OpaqueSignerProvider, fingerprintPublicKey } = require('../src/gateway/economic-signer-provider');

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKeyPem, privateKey };
}

function makeHarness() {
  const secrets = new Map();
  const provider = new OpaqueSignerProvider({
    providerId: 'signer_test_hsm_01',
    signDigest: async ({ keyHandle, challengeDigest, purpose }) => {
      assert.equal(purpose, 'NON_ECONOMIC_CANARY');
      const privateKey = secrets.get(keyHandle);
      if (!privateKey) throw new Error('opaque key unavailable');
      return { signatureBase64: sign(null, Buffer.from(challengeDigest), privateKey).toString('base64') };
    }
  });
  return { provider, secrets };
}

function requestFor(record, suffix = '01') {
  return prepareEconomicSignerCanary({
    nonce: 'canary_provider_' + suffix + '_123456',
    authorityLeaseId: 'auth_1234567890123456',
    approvalProofId: 'apr_1234567890123456',
    keyHandle: record.keyHandle,
    publicKeyFingerprint: record.publicKeyFingerprint,
    expiresAt: 1_900_000_000_000,
    externalEffects: 0
  });
}

test('opaque provider signs canary without exposing private material', async () => {
  const { provider, secrets } = makeHarness();
  const key = makeKey();
  secrets.set('keyref_hsm_canary_0001', key.privateKey);
  const record = provider.registerKey({ keyHandle:'keyref_hsm_canary_0001', publicKeyPem:key.publicKeyPem, generation:1 });
  const receipt = await provider.signCanary(requestFor(record), 1_800_000_000_000);
  assert.equal(receipt.providerId, 'signer_test_hsm_01');
  assert.equal(receipt.keyGeneration, 1);
  assert.equal(receipt.signingMaterialExposed, false);
  assert.equal(receipt.transactionPayloadSigned, false);
  assert.equal(receipt.canBroadcast, false);
  assert.equal(receipt.externalEffects, 0);
  assert.equal('privateKey' in receipt, false);
});

test('replay is rejected', async () => {
  const { provider, secrets } = makeHarness();
  const key = makeKey(); secrets.set('keyref_hsm_canary_0002', key.privateKey);
  const record = provider.registerKey({ keyHandle:'keyref_hsm_canary_0002', publicKeyPem:key.publicKeyPem, generation:1 });
  const request = requestFor(record, '02');
  await provider.signCanary(request, 1_800_000_000_000);
  await assert.rejects(() => provider.signCanary(request, 1_800_000_000_000), /REPLAY_REJECTED/);
});

test('rotation retires old key and binds generation/fingerprint chain', async () => {
  const { provider, secrets } = makeHarness();
  const k1=makeKey(), k2=makeKey();
  secrets.set('keyref_hsm_rotate_0001',k1.privateKey);
  secrets.set('keyref_hsm_rotate_0002',k2.privateKey);
  const first=provider.registerKey({keyHandle:'keyref_hsm_rotate_0001',publicKeyPem:k1.publicKeyPem,generation:1});
  const rotation=provider.rotateKey(first.keyHandle,{keyHandle:'keyref_hsm_rotate_0002',publicKeyPem:k2.publicKeyPem,generation:2});
  assert.equal(rotation.oldState,'RETIRED');
  assert.equal(rotation.newState,'ACTIVE');
  assert.equal(rotation.newGeneration,2);
  assert.equal(rotation.privateKeyMaterialTransferred,false);
  assert.equal(provider.keyStatus(first.keyHandle).state,'RETIRED');
  const second=provider.keyStatus('keyref_hsm_rotate_0002');
  assert.equal(second.previousKeyFingerprint,first.publicKeyFingerprint);
  await assert.rejects(() => provider.signCanary(requestFor(first,'03'),1_800_000_000_000),/KEY_NOT_ACTIVE/);
});

test('revocation blocks signing immediately', async () => {
  const { provider, secrets } = makeHarness();
  const key=makeKey(); secrets.set('keyref_hsm_revoke_0001',key.privateKey);
  const record=provider.registerKey({keyHandle:'keyref_hsm_revoke_0001',publicKeyPem:key.publicKeyPem,generation:1});
  const revoked=provider.revokeKey(record.keyHandle,'operator_kill_switch');
  assert.equal(revoked.state,'REVOKED');
  assert.equal(revoked.externalEffects,0);
  await assert.rejects(() => provider.signCanary(requestFor(record,'04'),1_800_000_000_000),/KEY_NOT_ACTIVE/);
});

test('provider cannot be tricked into transaction/effect-capable request', async () => {
  const { provider, secrets } = makeHarness();
  const key=makeKey(); secrets.set('keyref_hsm_bound_0001',key.privateKey);
  const record=provider.registerKey({keyHandle:'keyref_hsm_bound_0001',publicKeyPem:key.publicKeyPem,generation:1});
  const request=requestFor(record,'05');
  await assert.rejects(() => provider.signCanary({...request,transactionPayloadPresent:true},1_800_000_000_000),/EFFECT_BOUNDARY_VIOLATION/);
  await assert.rejects(() => provider.signCanary({...request,externalEffects:1},1_800_000_000_000),/EFFECT_BOUNDARY_VIOLATION/);
});
