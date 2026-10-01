'use strict';

function deny(reason, extra = {}) {
  return {
    schema: 'aftergraph.economic-signing-boundary-decision/v1',
    decision: 'DENY',
    allowed: false,
    signatureProduced: false,
    externalEffects: 0,
    reason,
    ...extra
  };
}

function evaluateEconomicSigningBoundary(input = {}) {
  const lifecycle = String(input.lifecycle || '').toLowerCase();
  const mode = String(input.mode || '').toLowerCase();
  const requestDigest = String(input.requestDigest || '');
  const keyHandle = String(input.keyHandle || '');
  const authorityLeaseId = String(input.authorityLeaseId || '');
  const approvalProofId = String(input.approvalProofId || '');
  const expiresAt = Number(input.expiresAt || 0);
  const now = Number(input.now || Date.now());
  const externalEffects = Number(input.externalEffects || 0);

  if (externalEffects !== 0) return deny('signer_boundary_requires_zero_effects');
  if (!['candidate', 'canonical'].includes(lifecycle)) return deny('economic_signing_lifecycle_ineligible');
  if (mode !== 'prepare') return deny('economic_signing_prepare_only');
  if (!/^sha256:[a-f0-9]{64}$/.test(requestDigest)) return deny('economic_signing_digest_invalid');
  if (!/^keyref_[a-zA-Z0-9_-]{12,}$/.test(keyHandle)) return deny('economic_signing_key_handle_invalid');
  if (!/^auth_[a-zA-Z0-9_-]{12,}$/.test(authorityLeaseId)) return deny('economic_signing_authority_missing');
  if (!/^apr_[a-zA-Z0-9_-]{12,}$/.test(approvalProofId)) return deny('economic_signing_human_approval_missing');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return deny('economic_signing_request_expired');

  return {
    schema: 'aftergraph.economic-signing-boundary-decision/v1',
    decision: 'PREPARED',
    allowed: true,
    reason: 'economic_signing_preparation_only',
    requestDigest,
    keyHandle,
    authorityLeaseId,
    approvalProofId,
    expiresAt,
    signatureProduced: false,
    signingMaterialExposed: false,
    canBroadcast: false,
    externalEffects: 0
  };
}

module.exports = { evaluateEconomicSigningBoundary };
