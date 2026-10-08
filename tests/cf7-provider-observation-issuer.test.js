'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, verify } = require('node:crypto');
const { issueCF7ProviderObservation } = require('../src/gateway/cf7-provider-observation-issuer');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const intent = {
  tenant_id:'tenant-a',space_id:'space-a',work_id:'work-a',run_id:'run-a',
  work_unit_id:'unit-a',step_id:'step-a',operation_id:'cf7-op-a',
  tool:'mail.send',session_id:'session-a',generation:2,
  action_digest:'action-a',args_digest:'args-a',
  authority_ref:'sha256:'+'a'.repeat(64), policy_ref:'sha256:'+'b'.repeat(64),
  status:'reconciliation_required'
};
const reference='provider-confirmed-op-a';
function adapters(overrides={}) {
  return {
    operationId:intent.operation_id, externalReference:reference,keyId:'cf7-test-key',
    loadIntent:async()=>({...intent}),
    verifyFence:async()=>({ok:true,generation:2}),
    checkAuthority:async()=>({decision:'allow',
      authoritySnapshotRef:intent.authority_ref,
      policySnapshotRef:intent.policy_ref}),
    readProviderObservation:async()=>({
      provider:'cloudflare',authenticated:true,outcome:'confirmed_success',
      operationId:intent.operation_id,externalReference:reference,
      worldStateDigest:'sha256:'+'c'.repeat(64),readbackId:'cf7-readback-a',observedAt:99000
    }),
    signDetached:async({payload})=>sign(null,payload,privateKey),
    now:()=>100000,ttlMs:30000,
    ...overrides
  };
}
test('issues an Ed25519 provider observation only after verified readback and double authority',async()=>{
  let guardCalls=0;
  const result=await issueCF7ProviderObservation(adapters({
    verifyFence:async()=>{guardCalls++;return {ok:true,generation:2};}
  }));
  assert.equal(result.issued,true);
  assert.equal(result.domainVerified,false);
  assert.equal(result.canExecute,false);
  assert.equal(guardCalls,2);
  const signed=result.evidence.providerAttestation;
  const bytes=Buffer.from(signed.payload,'base64url');
  const payload=JSON.parse(bytes.toString('utf8'));
  assert.equal(verify(null,bytes,publicKey,Buffer.from(signed.signature,'base64url')),true);
  assert.equal(payload.schema,'lume.cf7-provider-observation/1');
  assert.equal(payload.operationId,intent.operation_id);
  assert.equal(payload.runId,intent.run_id);
  assert.equal(payload.workUnitId,intent.work_unit_id);
  assert.equal(payload.generation,intent.generation);
  assert.equal(payload.outcome,'confirmed_success');
  assert.equal(payload.verified,false);
  assert.equal(payload.worldStateDigest,'sha256:'+'c'.repeat(64));
  assert.equal(JSON.stringify(payload).includes('token'),false);
});
test('denies fabricated, unsigned, mismatched or unauthenticated provider observations',async()=>{
  const good={provider:'cloudflare',authenticated:true,outcome:'confirmed_success',
    operationId:intent.operation_id,externalReference:reference,
    worldStateDigest:'sha256:'+'c'.repeat(64),readbackId:'cf7-readback-a',observedAt:99000};
  for(const patch of [
    {authenticated:false},{outcome:'unknown'},{operationId:'cf7-op-b'},
    {externalReference:'other-ref'},{provider:'unknown'},
    {worldStateDigest:'bogus'},{readbackId:''},{observedAt:1},{observedAt:100001}
  ]) {
    let signCalls=0;
    const result=await issueCF7ProviderObservation(adapters({
      readProviderObservation:async()=>({...good,...patch}),
      signDetached:async()=>{signCalls++;return Buffer.alloc(64);}
    }));
    assert.equal(result.issued,false);
    assert.equal(signCalls,0);
  }
});
test('denies missing, stale and post-readback revoked authority or lease',async()=>{
  assert.equal((await issueCF7ProviderObservation(adapters({checkAuthority:undefined}))).issued,false);
  assert.equal((await issueCF7ProviderObservation(adapters({loadIntent:async()=>null}))).issued,false);
  assert.equal((await issueCF7ProviderObservation(adapters({verifyFence:async()=>({ok:true,generation:1})}))).issued,false);
  let reads=0;
  const result=await issueCF7ProviderObservation(adapters({
    checkAuthority:async()=>({decision:++reads===1?'allow':'deny',
      authoritySnapshotRef:intent.authority_ref,policySnapshotRef:intent.policy_ref})
  }));
  assert.equal(result.issued,false);
  assert.equal(result.reason,'post_readback_authority_or_fence_lost');
});
test('fails closed when signer unavailable and never fabricates success',async()=>{
  assert.equal((await issueCF7ProviderObservation(adapters({signDetached:async()=>null}))).issued,false);
  assert.equal((await issueCF7ProviderObservation(adapters({signDetached:async()=>{throw Error('HSM offline');}}))).issued,false);
  assert.equal((await issueCF7ProviderObservation(adapters({ttlMs:600000}))).issued,false);
});
