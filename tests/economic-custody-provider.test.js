'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { OpaqueCustodyProvider } = require('../src/gateway/economic-custody-provider');

const sha = s => 'sha256:' + createHash('sha256').update(s).digest('hex');

function harness() {
  return new OpaqueCustodyProvider({
    providerId:'custodian_test_vault_01',
    inspectState: async ({ mode, custodyRef }) => {
      assert.equal(mode,'READ_ONLY');
      return { stateDigest:sha('state:'+custodyRef), observedAt:'2026-10-01T00:00:00Z' };
    },
    prepareRecoveryPlan: async ({ mode, challengeDigest }) => {
      assert.equal(mode,'DRY_RUN');
      return { planDigest:sha('plan:'+challengeDigest) };
    }
  });
}

function registered(provider) {
  return provider.registerReference({
    custodyRef:'cust_external_vault_0001',
    accountFingerprint:sha('account-1'),
    recoveryPolicyRef:'rec_two_person_recovery_0001'
  });
}

function recovery(ref, suffix='01') {
  return {
    custodyRef:ref.custodyRef,
    recoveryPolicyRef:ref.recoveryPolicyRef,
    authorityLeaseId:'auth_1234567890123456',
    approvalProofIds:['apr_operator_1234567890','apr_reviewer_1234567890'],
    nonce:'recovery_canary_'+suffix+'_123456',
    expiresAt:1_900_000_000_000,
    externalEffects:0
  };
}

test('custody observation is read-only and cannot move assets', async () => {
  const p=harness(), ref=registered(p);
  const out=await p.observe(ref.custodyRef);
  assert.equal(out.readOnly,true);
  assert.equal(out.liveWriteApiCalled,false);
  assert.equal(out.canMoveAssets,false);
  assert.equal(out.canWithdraw,false);
  assert.equal(out.externalEffects,0);
});

test('recovery canary requires two distinct approvals and remains dry-run', async () => {
  const p=harness(), ref=registered(p);
  const out=await p.prepareRecoveryCanary(recovery(ref),1_800_000_000_000);
  assert.equal(out.dryRun,true);
  assert.equal(out.twoPersonApprovalBound,true);
  assert.equal(out.assetMovementPerformed,false);
  assert.equal(out.final,false);
  assert.equal(out.externalEffects,0);
});

test('one approval is rejected', async () => {
  const p=harness(), ref=registered(p);
  await assert.rejects(() => p.prepareRecoveryCanary({...recovery(ref),approvalProofIds:['apr_operator_1234567890']},1_800_000_000_000),/TWO_PERSON_APPROVAL_REQUIRED/);
});

test('asset movement payload is forbidden', async () => {
  const p=harness(), ref=registered(p);
  await assert.rejects(() => p.prepareRecoveryCanary({...recovery(ref),destination:'bank-or-wallet'},1_800_000_000_000),/ASSET_MOVE_PAYLOAD_FORBIDDEN/);
});

test('recovery nonce replay is rejected', async () => {
  const p=harness(), ref=registered(p);
  const req=recovery(ref,'02');
  await p.prepareRecoveryCanary(req,1_800_000_000_000);
  await assert.rejects(() => p.prepareRecoveryCanary(req,1_800_000_000_000),/REPLAY_REJECTED/);
});

test('revoked custody reference cannot observe or recover', async () => {
  const p=harness(), ref=registered(p);
  const rev=p.revokeReference(ref.custodyRef,'operator_kill_switch');
  assert.equal(rev.state,'REVOKED');
  assert.equal(rev.canMoveAssets,false);
  assert.equal(rev.externalEffects,0);
  await assert.rejects(() => p.observe(ref.custodyRef),/NOT_ACTIVE/);
  await assert.rejects(() => p.prepareRecoveryCanary(recovery(ref,'03'),1_800_000_000_000),/NOT_ACTIVE/);
});
