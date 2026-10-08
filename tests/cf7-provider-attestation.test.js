'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {attestCF7ProviderObservation} = require('../src/gateway/cf7-provider-attestation');
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const hash=x=>'sha256:'+x.repeat(64);
const intent={operationId:'op-1',tenantId:'tenant-a',spaceId:'space-a',workId:'work-a',
  runId:'run-a',workUnitId:'unit-a',stepId:'step-a',sessionId:'session-a',
  tool:'mail.send',actionDigest:'action-a',argsDigest:'args-a',
  authorityRef:hash('a'),policyRef:hash('b'),externalReference:'remote-123',
  idempotencyKey:'key-a',generation:2};
let observed=0,signed=0;
const readProvider=async ({operationId,externalReference})=>{
  observed++;
  return {provider:'cloudflare',operationId,externalReference,
    outcome:'confirmed_success',authoritative:true};
};
const signWithCustody=async ({payload,purpose,algorithm})=>{
  signed++;
  assert.equal(purpose,'cf7.provider-observation');
  assert.equal(algorithm,'Ed25519');
  return crypto.sign(null,payload,privateKey);
};
const args=()=>({intent,readProvider,signWithCustody,keyId:'gateway-key-v1',now:()=>200000});
test('trusted provider readback signs exact Lume CF7 envelope without domain verdict',async()=>{
  observed=0;signed=0;
  const result=await attestCF7ProviderObservation(args());
  assert.equal(result.ok,true);
  assert.equal(result.verified,false);
  assert.equal(result.canExecute,false);
  const envelope=result.providerAttestation;
  const payload=Buffer.from(envelope.payload,'base64url');
  assert.equal(crypto.verify(null,payload,publicKey,Buffer.from(envelope.signature,'base64url')),true);
  const p=JSON.parse(payload.toString());
  assert.equal(p.workUnitId,'unit-a');
  assert.equal(p.sessionId,'session-a');
  assert.equal(p.generation,2);
  assert.equal(p.expiresAt,260000);
  assert.equal(p.verified,false);
  assert.equal(observed,1);assert.equal(signed,1);
});
test('unknown, failed or wrong identity provider outcomes never reach signer',async()=>{
  for(const result of [null,{provider:'cloudflare',outcome:'not_found'},
    {provider:'cloudflare',outcome:'confirmed_success',operationId:'other',externalReference:'remote-123',authoritative:true},
    {provider:'cloudflare',outcome:'confirmed_success',operationId:'op-1',externalReference:'remote-123',authoritative:false}]){
    signed=0;
    const out=await attestCF7ProviderObservation({...args(),readProvider:async()=>result});
    assert.equal(out.ok,false);
    assert.equal(signed,0);
  }
});
test('missing readback and signer, invalid policy or failed custody fail closed',async()=>{
  const invalid=[
    {...args(),readProvider:undefined},
    {...args(),signWithCustody:undefined},
    {...args(),intent:{...intent,policyRef:'bogus'}},
    {...args(),ttlMs:300001},
    {...args(),readProvider:async()=>{throw Error('offline')}},
    {...args(),signWithCustody:async()=>Buffer.alloc(8)},
  ];
  for(const item of invalid)assert.equal((await attestCF7ProviderObservation(item)).ok,false);
});
