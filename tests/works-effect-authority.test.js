'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateWorksEffectRevalidation:check}=require('../src/gateway/works-effect-authority');
const ACTION='act_'+'a'.repeat(32),AUTH='auth_'+'b'.repeat(32),HASH='sha256:'+'c'.repeat(64);
const fixture=()=>({
 schema:'aftergraph.works-effect-revalidation-request/1',
 actionId:ACTION,authorityLeaseId:AUTH,tenantId:'ten_'+'1'.repeat(32),
 principalId:'prn_'+'2'.repeat(32),missionId:'mis_test',
 workId:'wrk_'+'3'.repeat(32),worksExecutionId:'wex_test',
 executionContextId:'ctx_'+'4'.repeat(32),workerLeaseId:'lse_'+'5'.repeat(32),
 attemptId:'attempt_one',effectId:'effect_one',idempotencyKey:'idem_one',
 effectDigest:HASH,amount:3,
});
test('fresh effect-time AIE fingerprint uses its OWN action separate from accept-time',()=>{
 const input=fixture();let observed;
 const answer=check(input,{liveRevalidate:(id,scope)=>{
  observed={id,scope};
  return {ok:true,action_id:id,authority_lease_id:scope.args.authorityLeaseId};
 }});
 assert.equal(answer.allowed,true);
 assert.equal(answer.canDispatchEffect,false);
 assert.equal(observed.id,ACTION);
 assert.equal(observed.scope.bot,'works-runtime');
 assert.equal(observed.scope.tool,'execute_fenced_effect');
 assert.equal(observed.scope.args.worksExecutionId,input.worksExecutionId);
 assert.equal(observed.scope.args.effectDigest,HASH);
 assert.equal(observed.scope.args.amount,3);
 assert.equal(Object.hasOwn(observed.scope.args,'actionId'),false);
});
test('revoked, expired, unreachable and uncorrelated AIE deny effect-time admission',()=>{
 for(const fn of [
  ()=>({ok:false,code:'AIE-AUTH-003'}),
  ()=>({ok:false,code:'AIE-AUTH-002'}),
  ()=>({ok:true}),()=>({ok:true,action_id:ACTION,authority_lease_id:'auth_'+'d'.repeat(32)}),
  async()=>({ok:true,action_id:ACTION,authority_lease_id:AUTH}),
  ()=>{throw Error('offline');},
 ]){
  assert.equal(check(fixture(),{liveRevalidate:fn}).allowed,false);
 }
});
test('replay, changed scope and model-supplied grants fail before invoking AIE',()=>{
 const changes=[
  x=>{x.actionId='bad'},x=>{x.effectDigest='bad'},x=>{x.tenantId='other'},
  x=>{x.amount=0},x=>{x.amount=Number.MAX_SAFE_INTEGER},
  x=>{x.approved=true},x=>{x.canDispatchEffect=true},
  x=>{x.authorityLeaseId='auth_bad'},x=>{x.worksExecutionId=''},
 ];
 for(const mutate of changes){
  const value=fixture();mutate(value);let calls=0;
  assert.equal(check(value,{liveRevalidate:()=>{calls++;return {ok:true}}}).allowed,false);
  assert.equal(calls,0);
 }
});
