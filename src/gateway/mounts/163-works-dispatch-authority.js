'use strict';
// WORKS #106: operator-scoped accept-time AIE revalidation transport.
// This endpoint cannot issue authorization for external effects.
const { isOperator } = require('../tenants');
const { audit } = require('../events');
const { evaluateWorksDispatchRevalidation } = require('../works-dispatch-authority');

module.exports=function mountWorksDispatchAuthority(gw){
 gw.router.post('/v2/works/dispatch/revalidate',(req,res)=>{
  const operator=isOperator(req);
  if(!operator){res.statusCode=403;return res.end(JSON.stringify({error:'operator_required'}));}
  let raw='',length=0;
  req.on('data',chunk=>{
   length+=Buffer.byteLength(chunk);
   if(length<=8192)raw+=chunk;
  });
  req.on('end',()=>{
   res.setHeader('Content-Type','application/json');
   if(length>8192){res.statusCode=413;return res.end(JSON.stringify({error:'body_too_large'}));}
   let payload;
   try{payload=JSON.parse(raw);}catch{
    res.statusCode=400;return res.end(JSON.stringify({error:'invalid_json'}));
   }
   const verdict=evaluateWorksDispatchRevalidation(payload);
   audit('works_dispatch_revalidation',{
    by:operator.name,actionId:typeof payload?.actionId==='string'?payload.actionId:null,
    allowed:verdict.allowed,reason:verdict.reason||null,
   });
   res.statusCode=verdict.allowed?200:403;
   return res.end(JSON.stringify(verdict));
  });
 });
};
