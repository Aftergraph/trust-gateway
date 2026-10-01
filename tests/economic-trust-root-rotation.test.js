'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { authorizeEconomicTrustRootRotation }=require('../src/gateway/economic-trust-root-rotation');

const H=c=>'sha256:'+c.repeat(64);
const base={
  sourceClass:'registry',sourceId:'registry_1',
  priorTrustRootId:'root_registry_1',newTrustRootId:'root_registry_2',
  priorPublicKeyFingerprint:H('a'),newPublicKeyFingerprint:H('b'),
  priorGeneration:1,newGeneration:2,
  priorMinAttestationGeneration:1,newMinAttestationGeneration:5,
  authorityLeaseId:'auth_1234567890123456',
  approvalProofIds:['apr_operator_1234567890','apr_reviewer_1234567890'],
  rotationNonce:'rot_registry_1234567890',
  reason:'scheduled_key_rotation',
  now:1_800_000_000_000,expiresAt:1_800_000_060_000,
  externalEffects:0
};
const allow={
  verifyAuthorityLease:async()=>true,
  verifyApprovalProof:async()=>true
};

test('authorizes exact prepare-only root rotation with real verifier callbacks',async()=>{
  const out=await authorizeEconomicTrustRootRotation(base,allow);
  assert.equal(out.authorized,true);
  assert.equal(out.decision,'AUTHORIZED_PREPARE_ONLY');
  assert.equal(out.trustRootMutationAuthorized,true);
  assert.match(out.authorizationDigest,/^sha256:[a-f0-9]{64}$/);
  assert.equal(out.approvalsVerified,true);
  assert.equal(out.authorityVerified,true);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.liveValueEnabled,false);
  assert.equal(out.externalEffects,0);
});

test('caller-supplied approval ids are insufficient when verifier denies',async()=>{
  const out=await authorizeEconomicTrustRootRotation(base,{
    verifyAuthorityLease:async()=>true,
    verifyApprovalProof:async()=>false
  });
  assert.equal(out.authorized,false);
  assert.equal(out.reason,'trust_root_approval_not_verified');
});

test('caller-supplied authority lease is insufficient when authority verifier denies',async()=>{
  const out=await authorizeEconomicTrustRootRotation(base,{
    verifyAuthorityLease:async()=>false,
    verifyApprovalProof:async()=>true
  });
  assert.equal(out.authorized,false);
  assert.equal(out.reason,'trust_root_authority_not_verified');
});

for(const [name,patch,reason] of [
  ['single approval',{approvalProofIds:['apr_operator_1234567890']},'trust_root_two_person_approval_required'],
  ['duplicate approval',{approvalProofIds:['apr_same_123456789012','apr_same_123456789012']},'trust_root_two_person_approval_required'],
  ['generation gap',{newGeneration:3},'trust_root_generation_not_sequential'],
  ['floor regression',{newMinAttestationGeneration:0},'trust_root_floor_regression'],
  ['same root',{newTrustRootId:'root_registry_1',newPublicKeyFingerprint:H('a')},'trust_root_rotation_must_change_root'],
  ['expired',{expiresAt:1_799_999_999_999},'trust_root_rotation_expired'],
  ['effectful',{externalEffects:1},'trust_root_rotation_requires_zero_effects']
]){
  test('rejects '+name,async()=>{
    const out=await authorizeEconomicTrustRootRotation({...base,...patch},allow);
    assert.equal(out.authorized,false);
    assert.equal(out.reason,reason);
  });
}

test('missing verifier callbacks fails closed',async()=>{
  const out=await authorizeEconomicTrustRootRotation(base,{});
  assert.equal(out.authorized,false);
  assert.equal(out.reason,'trust_root_verifier_missing');
});
