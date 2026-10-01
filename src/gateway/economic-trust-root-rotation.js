'use strict';

const { createHash } = require('node:crypto');

const HASH=/^sha256:[a-f0-9]{64}$/;
const SOURCE_CLASSES=new Set(['registry','custody','representation']);

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function authorizeEconomicTrustRootRotation(input = {}, verifiers = {}) {
  const deny = reason => ({
    schema:'aftergraph.economic-trust-root-rotation-authorization/v1',
    decision:'DENY',
    authorized:false,
    trustRootMutationAuthorized:false,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reason
  });

  if (!SOURCE_CLASSES.has(String(input.sourceClass || ''))) return deny('trust_root_source_class_invalid');
  if (!String(input.sourceId || '').trim()) return deny('trust_root_source_id_required');
  if (!String(input.priorTrustRootId || '').trim() || !String(input.newTrustRootId || '').trim()) return deny('trust_root_id_required');
  if (!HASH.test(String(input.priorPublicKeyFingerprint || '')) || !HASH.test(String(input.newPublicKeyFingerprint || ''))) return deny('trust_root_fingerprint_invalid');
  if (input.priorPublicKeyFingerprint === input.newPublicKeyFingerprint && input.priorTrustRootId === input.newTrustRootId) return deny('trust_root_rotation_must_change_root');
  if (!Number.isInteger(input.priorGeneration) || input.priorGeneration < 1) return deny('trust_root_prior_generation_invalid');
  if (!Number.isInteger(input.newGeneration) || input.newGeneration !== input.priorGeneration + 1) return deny('trust_root_generation_not_sequential');
  if (!Number.isInteger(input.priorMinAttestationGeneration) || input.priorMinAttestationGeneration < 1) return deny('trust_root_prior_floor_invalid');
  if (!Number.isInteger(input.newMinAttestationGeneration) || input.newMinAttestationGeneration < input.priorMinAttestationGeneration) return deny('trust_root_floor_regression');
  if (!/^auth_[A-Za-z0-9_-]{12,}$/.test(String(input.authorityLeaseId || ''))) return deny('trust_root_authority_lease_invalid');

  const approvals=Array.isArray(input.approvalProofIds)?input.approvalProofIds.map(String):[];
  if (approvals.length < 2 || new Set(approvals).size !== approvals.length || approvals.some(x=>!/^apr_[A-Za-z0-9_-]{12,}$/.test(x))) {
    return deny('trust_root_two_person_approval_required');
  }
  if (!/^rot_[A-Za-z0-9_-]{12,}$/.test(String(input.rotationNonce || ''))) return deny('trust_root_rotation_nonce_invalid');
  const now=Number(input.now || Date.now());
  const expiresAt=Number(input.expiresAt || 0);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) return deny('trust_root_rotation_expired');
  if (Number(input.externalEffects || 0) !== 0) return deny('trust_root_rotation_requires_zero_effects');
  if (typeof verifiers.verifyAuthorityLease !== 'function' || typeof verifiers.verifyApprovalProof !== 'function') return deny('trust_root_verifier_missing');

  const authorityOK=await verifiers.verifyAuthorityLease({
    authorityLeaseId:String(input.authorityLeaseId),
    sourceClass:String(input.sourceClass),
    sourceId:String(input.sourceId),
    action:'economic.trust-root.rotate'
  });
  if (authorityOK !== true) return deny('trust_root_authority_not_verified');

  for (const approvalProofId of approvals) {
    const ok=await verifiers.verifyApprovalProof({
      approvalProofId,
      authorityLeaseId:String(input.authorityLeaseId),
      action:'economic.trust-root.rotate',
      sourceClass:String(input.sourceClass),
      sourceId:String(input.sourceId)
    });
    if (ok !== true) return deny('trust_root_approval_not_verified');
  }

  const payload={
    domain:'aftergraph/economic-trust-root-rotation/v1',
    purpose:'GOVERNED_TRUST_ROOT_ROTATION',
    sourceClass:String(input.sourceClass),
    sourceId:String(input.sourceId),
    priorTrustRootId:String(input.priorTrustRootId),
    newTrustRootId:String(input.newTrustRootId),
    priorPublicKeyFingerprint:String(input.priorPublicKeyFingerprint),
    newPublicKeyFingerprint:String(input.newPublicKeyFingerprint),
    priorGeneration:input.priorGeneration,
    newGeneration:input.newGeneration,
    priorMinAttestationGeneration:input.priorMinAttestationGeneration,
    newMinAttestationGeneration:input.newMinAttestationGeneration,
    authorityLeaseId:String(input.authorityLeaseId),
    approvalProofIds:approvals.slice().sort(),
    rotationNonce:String(input.rotationNonce),
    reason:String(input.reason || 'operator_rotation'),
    expiresAt
  };

  return {
    schema:'aftergraph.economic-trust-root-rotation-authorization/v1',
    decision:'AUTHORIZED_PREPARE_ONLY',
    authorized:true,
    trustRootMutationAuthorized:true,
    authorizationDigest:digest(payload),
    payload,
    approvalsVerified:true,
    authorityVerified:true,
    executionAuthority:false,
    liveValueEnabled:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0
  };
}

module.exports={authorizeEconomicTrustRootRotation};
