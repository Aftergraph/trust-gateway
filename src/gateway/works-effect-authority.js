'use strict';
// G18 #2095: independent, LIVE AIE effect-time check for WORKS.
// A valid acceptance-time action is NOT sufficient to perform an effect.
// This endpoint is a policy observation only: it never executes a provider.
const { revalidate } = require('./aie-client');
const ACTION=/^act_[a-f0-9]{32}$/u;
const AUTH=/^auth_[a-f0-9]{32}$/u;
const DIGEST=/^sha256:[a-f0-9]{64}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$/u;
const KEYS=['schema','actionId','authorityLeaseId','tenantId','principalId',
 'missionId','workId','worksExecutionId','executionContextId','workerLeaseId',
 'attemptId','effectId','idempotencyKey','effectDigest','amount'];
const SCOPE=KEYS.filter(k=>!['schema','actionId','effectDigest','amount'].includes(k));
function deny(reason){
 return Object.freeze({schema:'aftergraph.works-effect-revalidation/1',allowed:false,
  reason,canDispatchEffect:false});
}
function validate(input){
 try {
  if(!input||typeof input!=='object'||Array.isArray(input)||
     Object.getPrototypeOf(input)!==Object.prototype||
     Reflect.ownKeys(input).some(k=>typeof k!=='string'||!KEYS.includes(k)||
       !Object.hasOwn(Object.getOwnPropertyDescriptor(input,k),'value')))return false;
  if(input.schema!=='aftergraph.works-effect-revalidation-request/1'||
     !ACTION.test(input.actionId??'')||!AUTH.test(input.authorityLeaseId??'')||
     !DIGEST.test(input.effectDigest??'')||
     !Number.isSafeInteger(input.amount)||input.amount<=0||input.amount>10000000)return false;
  return SCOPE.every(key=>typeof input[key]==='string'&&ID.test(input[key]));
 }catch{return false;}
}
function evaluateWorksEffectRevalidation(input,{liveRevalidate=revalidate}={}){
 if(!validate(input))return deny('invalid_effect_scope');
 const args=Object.fromEntries(KEYS.filter(k=>!['schema','actionId'].includes(k))
  .map(k=>[k,input[k]]));
 let verdict;
 try{
  verdict=liveRevalidate(input.actionId,{
   bot:'works-runtime',tool:'execute_fenced_effect',args,
  });
 }catch{return deny('aie_unreachable');}
 if(!verdict||typeof verdict.then==='function'||verdict.ok!==true||
   verdict.action_id!==input.actionId||
   verdict.authority_lease_id!==input.authorityLeaseId)
  return deny('revoked_expired_or_unverifiable');
 return Object.freeze({schema:'aftergraph.works-effect-revalidation/1',
  allowed:true,actionId:input.actionId,authorityLeaseId:input.authorityLeaseId,
  effectDigest:input.effectDigest,worksExecutionId:input.worksExecutionId,
  executionContextId:input.executionContextId,effectId:input.effectId,
  idempotencyKey:input.idempotencyKey,amount:input.amount,
  canDispatchEffect:false});
}
module.exports={evaluateWorksEffectRevalidation};
