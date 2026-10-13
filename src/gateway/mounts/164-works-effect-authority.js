'use strict';
// Only a real operator may request this live AIE check, never a model token.
// No external effect and no approval/authorization bearer is minted here.
const {isOperator}=require('../tenants');
const {audit}=require('../events');
const {evaluateWorksEffectRevalidation}=require('../works-effect-authority');
module.exports=function mountWorksEffectAuthority(gw){
 gw.router.post('/v2/works/effects/revalidate',(req,res)=>{
  const op=isOperator(req);
  if(!op){res.statusCode=403;return res.end(JSON.stringify({error:'operator_required'}));}
  let input='',bytes=0;
  req.on('data',chunk=>{
   bytes+=Buffer.byteLength(chunk);
   if(bytes<=8192)input+=chunk;
  });
  req.on('end',()=>{
   res.setHeader('Content-Type','application/json');
   if(bytes>8192){res.statusCode=413;return res.end(JSON.stringify({error:'body_too_large'}));}
   let payload;
   try{payload=JSON.parse(input);}catch{
    res.statusCode=400;return res.end(JSON.stringify({error:'invalid_json'}));
   }
   const result=evaluateWorksEffectRevalidation(payload);
   audit('works_effect_revalidation',{
    by:op.name,actionId:typeof payload?.actionId==='string'?payload.actionId:null,
    worksExecutionId:typeof payload?.worksExecutionId==='string'?payload.worksExecutionId:null,
    allowed:result.allowed,reason:result.reason||null,
   });
   res.statusCode=result.allowed?200:403;
   res.end(JSON.stringify(result));
  });
 });
};
