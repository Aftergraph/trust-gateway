'use strict';

const { createHash } = require('node:crypto');

function digestJson(value) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
}

class OpaqueCustodyProvider {
  #providerId;
  #inspectState;
  #prepareRecoveryPlan;
  #refs = new Map();
  #usedRecoveryNonces = new Set();

  constructor({ providerId, inspectState, prepareRecoveryPlan }) {
    if (!/^custodian_[A-Za-z0-9_-]{8,}$/.test(String(providerId || ''))) throw new Error('CUSTODY_PROVIDER_ID_INVALID');
    if (typeof inspectState !== 'function') throw new Error('CUSTODY_PROVIDER_INSPECT_CALLBACK_REQUIRED');
    if (typeof prepareRecoveryPlan !== 'function') throw new Error('CUSTODY_PROVIDER_RECOVERY_CALLBACK_REQUIRED');
    this.#providerId = providerId;
    this.#inspectState = inspectState;
    this.#prepareRecoveryPlan = prepareRecoveryPlan;
  }

  registerReference({ custodyRef, accountFingerprint, recoveryPolicyRef }) {
    if (!/^cust_[A-Za-z0-9_-]{12,}$/.test(String(custodyRef || ''))) throw new Error('CUSTODY_REFERENCE_INVALID');
    if (!/^sha256:[a-f0-9]{64}$/.test(String(accountFingerprint || ''))) throw new Error('CUSTODY_ACCOUNT_FINGERPRINT_INVALID');
    if (!/^rec_[A-Za-z0-9_-]{12,}$/.test(String(recoveryPolicyRef || ''))) throw new Error('CUSTODY_RECOVERY_POLICY_INVALID');
    if (this.#refs.has(custodyRef)) throw new Error('CUSTODY_REFERENCE_ALREADY_EXISTS');
    const record = { custodyRef, accountFingerprint, recoveryPolicyRef, state:'ACTIVE' };
    this.#refs.set(custodyRef, record);
    return { ...record };
  }

  revokeReference(custodyRef, reason = 'operator_revocation') {
    const ref = this.#refs.get(custodyRef);
    if (!ref) throw new Error('CUSTODY_REFERENCE_NOT_FOUND');
    ref.state = 'REVOKED';
    return {
      schema:'aftergraph.custody-reference-revocation/v1',
      providerId:this.#providerId,
      custodyRef,
      accountFingerprint:ref.accountFingerprint,
      recoveryPolicyRef:ref.recoveryPolicyRef,
      reason,
      state:'REVOKED',
      canMoveAssets:false,
      externalEffects:0
    };
  }

  async observe(custodyRef) {
    const ref = this.#refs.get(custodyRef);
    if (!ref || ref.state !== 'ACTIVE') throw new Error('CUSTODY_REFERENCE_NOT_ACTIVE');
    const observed = await this.#inspectState({
      providerId:this.#providerId,
      custodyRef,
      accountFingerprint:ref.accountFingerprint,
      mode:'READ_ONLY'
    });
    if (!observed || typeof observed.stateDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(observed.stateDigest)) {
      throw new Error('CUSTODY_STATE_DIGEST_INVALID');
    }
    return {
      schema:'aftergraph.external-custody-observation/v1',
      providerId:this.#providerId,
      custodyRef,
      accountFingerprint:ref.accountFingerprint,
      recoveryPolicyRef:ref.recoveryPolicyRef,
      stateDigest:observed.stateDigest,
      observedAt:observed.observedAt || new Date(0).toISOString(),
      readOnly:true,
      liveWriteApiCalled:false,
      canMoveAssets:false,
      canWithdraw:false,
      canRecoverAssets:false,
      externalEffects:0
    };
  }

  async prepareRecoveryCanary(input = {}, now = Date.now()) {
    const custodyRef = String(input.custodyRef || '');
    const ref = this.#refs.get(custodyRef);
    if (!ref || ref.state !== 'ACTIVE') throw new Error('CUSTODY_REFERENCE_NOT_ACTIVE');
    if (input.recoveryPolicyRef !== ref.recoveryPolicyRef) throw new Error('CUSTODY_RECOVERY_POLICY_MISMATCH');
    if (!/^auth_[A-Za-z0-9_-]{12,}$/.test(String(input.authorityLeaseId || ''))) throw new Error('CUSTODY_AUTHORITY_INVALID');
    const approvals = Array.isArray(input.approvalProofIds) ? input.approvalProofIds.map(String) : [];
    if (approvals.length < 2 || new Set(approvals).size !== approvals.length || approvals.some(x => !/^apr_[A-Za-z0-9_-]{12,}$/.test(x))) {
      throw new Error('CUSTODY_TWO_PERSON_APPROVAL_REQUIRED');
    }
    const nonce = String(input.nonce || '');
    if (!/^recovery_[A-Za-z0-9_-]{12,}$/.test(nonce)) throw new Error('CUSTODY_RECOVERY_NONCE_INVALID');
    if (this.#usedRecoveryNonces.has(nonce)) throw new Error('CUSTODY_RECOVERY_REPLAY_REJECTED');
    const expiresAt = Number(input.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('CUSTODY_RECOVERY_EXPIRED');
    if (Number(input.externalEffects || 0) !== 0) throw new Error('CUSTODY_RECOVERY_REQUIRES_ZERO_EFFECTS');
    if (input.assetMovement !== undefined || input.withdrawal !== undefined || input.destination !== undefined) {
      throw new Error('CUSTODY_RECOVERY_ASSET_MOVE_PAYLOAD_FORBIDDEN');
    }

    const challenge = {
      domain:'aftergraph/economic-custody-recovery-canary/v1',
      purpose:'NON_ECONOMIC_RECOVERY_DRY_RUN',
      providerId:this.#providerId,
      custodyRef,
      accountFingerprint:ref.accountFingerprint,
      recoveryPolicyRef:ref.recoveryPolicyRef,
      authorityLeaseId:String(input.authorityLeaseId),
      approvalProofIds:approvals.slice().sort(),
      nonce,
      expiresAt
    };
    const challengeDigest = digestJson(challenge);
    const plan = await this.#prepareRecoveryPlan({
      providerId:this.#providerId,
      custodyRef,
      recoveryPolicyRef:ref.recoveryPolicyRef,
      challengeDigest,
      mode:'DRY_RUN'
    });
    if (!plan || !/^sha256:[a-f0-9]{64}$/.test(String(plan.planDigest || ''))) {
      throw new Error('CUSTODY_RECOVERY_PLAN_DIGEST_INVALID');
    }
    this.#usedRecoveryNonces.add(nonce);
    return {
      schema:'aftergraph.custody-recovery-canary-receipt/v1',
      challenge,
      challengeDigest,
      planDigest:plan.planDigest,
      dryRun:true,
      twoPersonApprovalBound:true,
      authorityLeaseBound:true,
      liveWriteApiCalled:false,
      assetMovementRequested:false,
      assetMovementPerformed:false,
      canMoveAssets:false,
      canWithdraw:false,
      canRecoverAssets:false,
      final:false,
      externalEffects:0
    };
  }
}

module.exports = { OpaqueCustodyProvider };
