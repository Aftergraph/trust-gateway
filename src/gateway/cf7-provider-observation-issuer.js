'use strict';
const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_AGE_MS = 60000;
function deny(reason) {
  return Object.freeze({ schema: 'aftergraph.cf7-provider-attestation-issue/1',
    issued: false, reason, canExecute: false, domainVerified: false });
}
function validIntent(intent) {
  if (!intent || typeof intent !== 'object') return false;
  for (const key of ['tenant_id','space_id','work_id','run_id','work_unit_id',
    'step_id','tool','session_id','operation_id']) {
    if (!ID.test(intent[key] || '')) return false;
  }
  return Number.isSafeInteger(intent.generation) && intent.generation > 0 &&
    ['action_digest','args_digest'].every(key => typeof intent[key] === 'string' && intent[key].length > 0 && intent[key].length <= 128) &&
    HASH.test(intent.authority_ref || '') && HASH.test(intent.policy_ref || '');
}
function liveGuards(a, intent) {
  return a?.fence?.ok === true &&
    a.fence.generation === intent.generation &&
    a.authority?.decision === 'allow' &&
    a.authority.authoritySnapshotRef === intent.authority_ref &&
    a.authority.policySnapshotRef === intent.policy_ref;
}
/**
 * Backend-only CF7 attestation issuer. Read-only, cannot execute, reconcile,
 * mutate Work, or grant a G29 domain verdict.
 * All five injected services MUST be supplied by a trusted gateway backend;
 * NEVER accept adapters or signing authority from a Workflow/plugin/request.
 * The provider observation adapter MUST authenticate real provider readback.
 */
async function issueCF7ProviderObservation({
  operationId, externalReference, keyId, loadIntent,
  verifyFence, checkAuthority, readProviderObservation, signDetached,
  now = () => Date.now(), ttlMs = 30000
} = {}) {
  if (!ID.test(operationId || '') || typeof externalReference !== 'string' ||
      externalReference.length < 1 || Buffer.byteLength(externalReference) > 2048 ||
      /[\u0000-\u001f\u007f]/.test(externalReference)) return deny('invalid_operation_or_reference');
  if (!ID.test(keyId || '') || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_AGE_MS) {
    return deny('invalid_key_or_expiry');
  }
  if ([loadIntent, verifyFence, checkAuthority, readProviderObservation, signDetached]
      .some(fn => typeof fn !== 'function')) return deny('trusted_backend_dependencies_missing');
  let intent;
  try { intent = await loadIntent(operationId); } catch { return deny('canonical_intent_unavailable'); }
  if (!validIntent(intent) || intent.operation_id !== operationId ||
      intent.status !== 'reconciliation_required') return deny('canonical_intent_invalid');
  async function guards() {
    const fence = await verifyFence({ intent, operationId });
    const authority = await checkAuthority({ intent, operationId });
    return { fence, authority };
  }
  try {
    if (!liveGuards(await guards(), intent)) return deny('fresh_authority_or_fence_missing');
    // Never pass raw args, credentials, or caller success claims to readback.
    const observation = await readProviderObservation(Object.freeze({
      provider: 'cloudflare', operationId, externalReference,
      tenantId: intent.tenant_id, runId: intent.run_id, workUnitId: intent.work_unit_id
    }));
    if (!observation || observation.provider !== 'cloudflare' ||
        observation.authenticated !== true ||
        observation.outcome !== 'confirmed_success' ||
        observation.operationId !== operationId ||
        observation.externalReference !== externalReference ||
        !HASH.test(observation.worldStateDigest || '') ||
        !ID.test(observation.readbackId || '')) return deny('authenticated_provider_readback_missing');
    if (!liveGuards(await guards(), intent)) return deny('post_readback_authority_or_fence_lost');
    const clock = now();
    if (!Number.isSafeInteger(clock) || clock <= 0) return deny('invalid_clock');
    if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt > clock ||
        clock - observation.observedAt >= ttlMs) return deny('provider_readback_stale');
    const payload = {
      schema: 'lume.cf7-provider-observation/1', issuer: 'aftergraph.trust-gateway/cf7/1',
      provider: 'cloudflare', outcome: 'confirmed_success', verified: false,
      operationId, runId: intent.run_id, workUnitId: intent.work_unit_id,
      externalReference, tenantId: intent.tenant_id, spaceId: intent.space_id,
      workId: intent.work_id, stepId: intent.step_id,
      sessionId: intent.session_id, generation: intent.generation,
      tool: intent.tool, actionDigest: intent.action_digest,
      argsDigest: intent.args_digest, authorityRef: intent.authority_ref,
      policyRef: intent.policy_ref, providerReadbackId: observation.readbackId,
      worldStateDigest: observation.worldStateDigest,
      observedAt: observation.observedAt, expiresAt: observation.observedAt + ttlMs
    };
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = await signDetached({ keyId, payload: bytes });
    if (!Buffer.isBuffer(signature) || signature.length !== 64) return deny('trusted_signer_unavailable');
    return Object.freeze({
      schema: 'aftergraph.cf7-provider-attestation-issue/1',
      issued: true, canExecute: false, domainVerified: false,
      evidence: { providerAttestation: {
        schema: 'lume.cf7-signed-provider-attestation/1', keyId,
        payload: bytes.toString('base64url'),
        signature: signature.toString('base64url')
      }},
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    });
  } catch {
    return deny('provider_readback_or_signer_unavailable');
  }
}
module.exports = { issueCF7ProviderObservation };
