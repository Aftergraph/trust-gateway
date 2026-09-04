
const mount = require('../src/gateway/mounts/33-takeover.js');
const { EventEmitter } = require('node:events');
function approvals(list){ return { list: () => list, deny: (id,x)=>{} }; }
async function run(gw, method, pathStr, body) {
  const res = { statusCode: null, body: null, writeHead(s){this.statusCode=s;}, end(b){this.body=b;} };
  const payload = body ? JSON.stringify(body) : '';
  const req = new EventEmitter(); req.method = method; req.headers = {};
  req.on = function(ev, cb) { if (ev==='data' && payload) setImmediate(()=>cb(Buffer.from(payload))); if (ev==='end') setImmediate(cb); return req; };
  try {
    await mount.handle(gw, req, res, { url: new URL('http://x'+pathStr), bot: {name:'op', role:'operator'} });
    return res;
  } catch (e) { return { statusCode: 'THREW', body: String(e) }; }
}
(async () => {
  const gw = { _audit: ()=>{}, _approvals: approvals([]), _chain: { entries: () => [{ payload: { type: 'action_admitted', bot: 'p1', capabilities: ['read'] } }] } };
  const issue = await run(gw, 'POST', '/v2/takeover', { principal_id: 'p1', reason: 'x' });
  console.log('issue:', issue.statusCode, issue.body);
  const id = JSON.parse(issue.body).takeover.id;
  const hb = await run(gw, 'POST', `/v2/takeover/${id}/hand-back`, {});
  console.log('HANDBACK:', hb.statusCode, String(hb.body).slice(0,150));
})();
