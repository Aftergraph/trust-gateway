'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateWorksDispatchRevalidation:verify}=require('../src/gateway/works-dispatch-authority');
const A='act_'+'a'.repeat(32),B='auth_'+'b'.repeat(32),D='sha256:'+'d'.repeat(64);
const valid=()=>({
 schema:'aftergraph.works-dispatch-revalidation-request/1',
 actionId:A,authorityLeaseId:B,organizationId:'org_'+'1'.repeat(32),
 tenantId:'ten_'+'2'.repeat(32),principalId:'prn_'+'3'.repeat(32),
 missionId:'mis_test',workId:'wrk_'+'4'.repeat(32),
 workerLeaseId:'lse_'+'5'.repeat(32),runtimeDispatchId:'rdisp_one',
 attemptId:'attempt_one',effectId:'effect_one',idempotencyKey:'idem_one',
 budgetCeiling:100,effectDigest:D,
});
const allow=(id,ctx)=>({ok:true,action_id:id,authority_lease_id:ctx.args.authorityLeaseId});
test('real AIE interface must correlate action, authority and exact immutable effects',()=>{
 let observed;const input=valid();
 const verdict=verify(input,{liveRevalidate:(id,c)=>{observed={id,c};return allow(id,c)}});
 assert.equal(verdict.allowed,true);
 assert.equal(verdict.canDispatchEffect,false);
 assert.equal(observed.id,A);
 assert.equal(observed.c.bot,'works-runtime');
 assert.equal(observed.c.tool,'accept_dispatch_v2');
 assert.deepEqual(observed.c.args,{organizationId:input.organizationId,tenantId:input.tenantId,
 principalId:input.principalId,missionId:input.missionId,workId:input.workId,
 authorityLeaseId:input.authorityLeaseId,workerLeaseId:input.workerLeaseId,
 runtimeDispatchId:input.runtimeDispatchId,attemptId:input.attemptId,effectId:input.effectId,
 idempotencyKey:input.idempotencyKey,budgetCeiling:input.budgetCeiling,effectDigest:input.effectDigest});
});
test('revoked, expired, offline and missing correlation cannot grant accept',()=>{
 for(const revalidate of [
 ()=>({ok:false,code:'AIE-AUTH-003'}),
 ()=>({ok:false,code:'AIE-AUTH-002'}),
 ()=>({ok:true}),
 ()=>({ok:true,action_id:A,authority_lease_id:'auth_'+'c'.repeat(32)}),
 ()=>{throw Error('bridge offline')},
 async()=>({ok:true,action_id:A,authority_lease_id:B}),
 ]){
  assert.equal(verify(valid(),{liveRevalidate:revalidate}).allowed,false);
 }
});
test('scope tampering and self-asserted permissions fail closed',()=>{
 for(const tweak of [
  x=>{x.authorityLeaseId='auth_fake'},x=>{x.actionId='x'},
  x=>{x.budgetCeiling=-1},x=>{x.effectDigest='x'},
  x=>{x.tenantId=''},x=>{x.approved=true},
  x=>{x.action_id=x.actionId},
 ]){
  const x=valid();tweak(x);
  assert.equal(verify(x,{liveRevalidate:allow}).allowed,false);
 }
});
