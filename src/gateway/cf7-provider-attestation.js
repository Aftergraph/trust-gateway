'use strict';

const crypto = require('node:crypto');
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const BOUND = ['operationId','tenantId','spaceId','workId','runId','workUnitId','stepId','sessionId','tool','actionDigest','argsDigest','authorityRef','policyRef','externalReference'];
const fail = (reason) => Object.freeze({ok:false,reason,canExecute:false,verified:false});

/**
 * Only a trusted gateway backend can supply provider readback and a custody
 * signer. No caller-provided provider outcome is ever trusted or signed.
 * The result is evidence of provider observation, never domain Verification.
 */
async function attestCF7ProviderObservation({intent,readProvider,signWithCustody,keyId,now=Date.now,ttlMs=60000}={}) {
  if (!intent || !BOUND.every(k => typeof intent[k] === 'string' && intent[k].length > 0) ||
      !Number.isSafeInteger(intent.generation) || intent.generation < 1 ||
      !HASH.test(intent.authorityRef) || !HASH.test(intent.policyRef) ||
      !ID.test(keyId||'') || typeof readProvider !== 'function' ||
      typeof signWithCustody !== 'function' || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 || ttlMs > 300000) return fail('invalid_trusted_boundary');
  let observation;
  try {
    // Provider readback is always performed server-side by an approved adapter.
    observation = await readProvider(Object.freeze({
      operationId:intent.operationId,externalReference:intent.externalReference,
      idempotencyKey:intent.idempotencyKey,provider:'cloudflare',
    }));
  } catch { return fail('provider_readback_unavailable'); }
  if (!observation || observation.provider !== 'cloudflare' ||
      observation.outcome !== 'confirmed_success' ||
      observation.externalReference !== intent.externalReference ||
      observation.operationId !== intent.operationId ||
      observation.authoritative !== true) return fail('provider_result_unconfirmed');
  const observedAt=Number(now());
  if (!Number.isSafeInteger(observedAt) || observedAt < 1) return fail('invalid_clock');
  const payload={schema:'lume.cf7-provider-observation/1',provider:'cloudflare',
    outcome:'confirmed_success',verified:false};
  for (const key of BOUND) payload[key]=intent[key];
  payload.generation=intent.generation;
  payload.observedAt=observedAt;
  payload.expiresAt=observedAt+ttlMs;
  const bytes=Buffer.from(JSON.stringify(payload));
  if (bytes.length > 8192) return fail('proof_too_large');
  let signature;
  try {
    signature=await signWithCustody(Object.freeze({
      keyId,algorithm:'Ed25519',payload:Buffer.from(bytes),
      purpose:'cf7.provider-observation',
    }));
  } catch { return fail('custody_signing_unavailable'); }
  if (!Buffer.isBuffer(signature) || signature.length !== 64) return fail('invalid_custody_signature');
  return Object.freeze({ok:true,canExecute:false,verified:false,
    providerAttestation:Object.freeze({
      schema:'lume.cf7-signed-provider-attestation/1',keyId,
      payload:bytes.toString('base64url'),signature:signature.toString('base64url'),
    })});
}
module.exports={attestCF7ProviderObservation};
