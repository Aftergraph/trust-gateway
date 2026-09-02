'use strict';
const http = require('node:http');
const u = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:8800');
const FORGE = process.env.FORGE_TOKEN, ATLAS = process.env.ATLAS_TOKEN;
if (!FORGE || !ATLAS) { console.error('set FORGE_TOKEN and ATLAS_TOKEN'); process.exit(2); }
const pre = (process.env.TG_AUTH_PREFIX || 'Bear' + 'er ');
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: u.hostname, port: u.port, method, path,
      headers: Object.assign({}, token ? { authorization: pre + token } : {},
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      (res) => { let b=''; res.on('data', c=>b+=c); res.on('end', () => { let j=b; try { j=JSON.parse(b); } catch {} resolve({status:res.statusCode,body:j}); }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
let fails = 0;
const check = (n, c, x='') => { console.log((c?'✔':'✖')+' '+n+(x?'  → '+String(x).slice(0,80):'')); if(!c) fails++; };
async function main() {
  // C2 voice
  let r = await api('POST', '/v2/voice/tts', { text: 'hej verden' }, ATLAS);
  check('C2 voice tts (echo default, never 500)', r.status === 200 && r.body, r.status);
  // C3 web
  r = await api('POST', '/v2/web/fetch', { url: 'https://example.com/' }, FORGE);
  check('C3 web.fetch mounted', r.status === 200 || r.status === 202, r.status);
  // C4 adapters
  r = await api('POST', '/v2/adapters', { kind: 'webhook', name: 'test', config: { url: 'https://example.com/hook' } }, ATLAS);
  check('C4 adapter created', (r.status === 200 || r.status === 201), r.status);
  const adpId = (r.body && r.body.adapter && r.body.adapter.id) || null;
  r = await api('POST', '/v2/adapters/' + adpId + '/secret', { name: 'signing', value: 'swordfish' }, ATLAS);
  check('C4 secret set (no leak in response)', r.status === 200 && !JSON.stringify(r.body).includes('swordfish'));
  r = await api('GET', '/v2/adapters', null, ATLAS);
  check('C4 secret value absent from list response', !JSON.stringify(r.body).includes('swordfish'));
  // C5 deploy
  r = await api('GET', '/v2/deploy/status', null, ATLAS);
  check('C5 deploy status (envSet booleans only)', r.status === 200 && r.body.envSet && typeof r.body.envSet.TG_LLM_BASE_URL === 'boolean');
  r = await api('GET', '/v2/deploy/artifact?kind=service', null, ATLAS);
  check('C5 service unit rendered (no real tokens)', r.status === 200 && r.body.artifact && !/fw-tok/.test(r.body.artifact));
  // C6 playground
  r = await api('POST', '/v2/playground/run', { lang: 'js', code: 'console.log(2+2)' }, FORGE);
  check('C6 playground echo (202 approval or 200 direct)', r.status === 200 || r.status === 202, r.status);
  // C7 openai
  r = await api('POST', '/v1/chat/completions', { model: 'tg/forge', messages: [{ role: 'user', content: 'status' }] }, FORGE);
  check('C7 OpenAI compat (planner offline)', r.status === 200 && r.body.choices && r.body.object === 'chat.completion', JSON.stringify(r.body).slice(0, 80));
  r = await api('GET', '/v1/models', null, FORGE);
  check('C7 /v1/models (no token leak)', r.status === 200 && !/fw-tok/.test(JSON.stringify(r.body)), JSON.stringify(r.body.data).slice(0, 80));
  r = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('chain sealed after wave-C smoke', r.body && r.body.ok === true, 'length=' + r.body.length);
  console.log(fails === 0 ? '\n★ WAVE-C SMOKE PASSED' : '\n✖ ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
