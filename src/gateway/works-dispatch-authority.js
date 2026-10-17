'use strict';
// WORKS #106: live AIE accept-time authority revalidation.
// Reuses Trust Gateway's actual persisted-AIE revalidate bridge. This
// grants ONLY dispatch acceptance, NEVER authority for an external effect.
const { revalidate } = require('./aie-client');
const ACTION = /^act_[a-f0-9]{32}$/u;
const AUTH = /^auth_[a-f0-9]{32}$/u;
const HEX = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$/u;
const KEYS = ['schema','actionId','authorityLeaseId','organizationId','tenantId',
 'principalId','missionId','workId','workerLeaseId','runtimeDispatchId','attemptId',
 'effectId','idempotencyKey','budgetCeiling','effectDigest'];
const ARGS = ['organizationId','tenantId','principalId','missionId','workId',
 'authorityLeaseId','workerLeaseId','runtimeDispatchId','attemptId','effectId',
 'idempotencyKey','budgetCeiling','effectDigest'];
const denied=(reason)=>Object.freeze({schema:'aftergraph.works-dispatch-revalidation/1',
 allowed:false,reason,canDispatchEffect:false});
function plain(input) {
 if(!input||typeof input!=='object'||Array.isArray(input)||
 Object.getPrototypeOf(input)!==Object.prototype)return false;
 return Reflect.ownKeys(input).every(k=>typeof k==='string'&&KEYS.includes(k)&&
 Object.hasOwn(Object.getOwnPropertyDescriptor(input,k),'value'));
}
function evaluateWorksDispatchRevalidation(input, { liveRevalidate=revalidate }={}){
 try{
  if(!plain(input)||input.schema!=='aftergraph.works-dispatch-revalidation-request/1'||
   !ACTION.test(input.actionId||'')||!AUTH.test(input.authorityLeaseId||'')||
   !HEX.test(input.effectDigest||'')||
   !ARGS.filter(x=>x!=='budgetCeiling'&&x!=='effectDigest'&&x!=='authorityLeaseId')
   .every(x=>typeof input[x]==='string'&&ID.test(input[x]))||
   !Number.isSafeInteger(input.budgetCeiling)||input.budgetCeiling<0)
   return denied('invalid_scope');
  const args=Object.fromEntries(ARGS.map(k=>[k,input[k]]));
  // AIE authenticates action_id AND the entire immutable bot/tool/args
  // fingerprint from its persisted admission state. Never trust a caller's
  // own "allowed" claim or mere possession of an authority lease ID.
  const verdict=liveRevalidate(input.actionId,{
   bot:'works-runtime',tool:'accept_dispatch_v2',args,
  });
  if(!verdict||typeof verdict.then==='function'||verdict.ok!==true||
   verdict.action_id!==input.actionId||
   verdict.authority_lease_id!==input.authorityLeaseId)
    return denied('authority_unavailable_or_stale');
  return Object.freeze({schema:'aftergraph.works-dispatch-revalidation/1',
   allowed:true,actionId:input.actionId,
   authorityLeaseId:input.authorityLeaseId,
   effectDigest:input.effectDigest,canDispatchEffect:false});
 }catch{return denied('authority_unavailable_or_stale')}
}
module.exports={evaluateWorksDispatchRevalidation};
