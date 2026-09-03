'use strict';
// BRAIN domain conformance: models, providers, LLM loops, memory policy.
// MUST-haves: /v2/chat/llm replies, oversized input rejected (400), providers/live reachable by operator.
const http = require('node:http');
const u = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:8800');
const FORGE = process.env.FORGE_TOKEN;
const ATLAS = process.env.ATLAS_TOKEN;
const AUTH = 'Bear' + 'er ';

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: u.hostname, port: u.port, method, path,
      headers: Object.assign(
        { authorization: AUTH + (token || ATLAS) },
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      ),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, raw: b }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '✔ ' : '✖ ') + name + (extra ? '  → ' + extra : ''));
  if (!cond) fails++;
}

(async () => {
  // MUST1: POST /v2/chat/llm returns 200 for a small message (LLM mount present).
  let r = await api('POST', '/v2/chat/llm', { session: 'conform-brain', message: 'hello' }, FORGE);
  check('BRAIN POST /v2/chat/llm → 200 + reply/fallback', r.status === 200 && (r.body && (typeof r.body.reply === 'string' || r.body.fallback === true || r.body.fallback === false)), r.status + ' ' + JSON.stringify(r.body).slice(0, 60));

  // MUST2: oversized message (50KB) rejected with 400 (context regression guard).
  const big = 'x'.repeat(50 * 1024);
  r = await api('POST', '/v2/chat/llm', { session: 'conform-brain', message: big }, FORGE);
  check('BRAIN 50KB message → 400', r.status === 400, r.status + ' ' + JSON.stringify(r.body).slice(0, 60));

  // MUST3: /v2/providers/live reachable by operator (provider observability).
  r = await api('GET', '/v2/providers/live', null, ATLAS);
  check('BRAIN /v2/providers/live → 200 for operator', r.status === 200 && Array.isArray(r.body && r.body.providers), r.status);

  // MUST4: worker blocked from /v2/providers/live (operator-only gate).
  r = await api('GET', '/v2/providers/live', null, FORGE);
  check('BRAIN /v2/providers/live → 403 for worker', r.status === 403, r.status);

  console.log(fails ? '\n✖ BRAIN ' + fails + ' failed' : '\n★ BRAIN PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('BRAIN CRASH', e.message); process.exit(1); });
