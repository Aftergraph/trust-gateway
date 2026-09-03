'use strict';
// OUTPUT domain conformance: artifacts, history, playground results, exports.
// MUST-haves: artifact creation works, search returns typed results, chain sealed.
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
  // MUST1: POST /v2/artifacts creates an artifact (output surface).
  const art = await api('POST', '/v2/artifacts', { kind: 'doc', title: 'conform-output', content: 'v1', bot: 'forge' }, FORGE);
  const artId = art.body && (art.body.artifact || art.body) && ((art.body.artifact || art.body).id);
  check('OUTPUT POST /v2/artifacts → 200/201 + artifact.id', (art.status === 200 || art.status === 201) && !!artId, art.status + ' ' + (artId || ''));

  // MUST2: GET /v2/search returns typed search results (history/export surface).
  const q = '/v2/search?q=conform&token=' + encodeURIComponent(ATLAS);
  const sr = await api('GET', q, null, ATLAS);
  check('OUTPUT /v2/search → 200 + hits', sr.status === 200 && (sr.body && Array.isArray(sr.body.hits) || Array.isArray(sr.body)), sr.status);

  // MUST3: chain verify ok after artifact creation.
  const v = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('OUTPUT chain verify ok:true', v.body && v.body.ok === true, 'len=' + (v.body && v.body.length));

  // MUST4: artifact versioning — PUT /v2/artifacts/:id works.
  if (artId) {
    const up = await api('PUT', '/v2/artifacts/' + artId, { content: 'v2', bot: 'forge' }, FORGE);
    check('OUTPUT PUT /v2/artifacts/:id → 200 + versioned', up.status === 200 && /version/.test(JSON.stringify(up.body)), up.status);
  } else {
    check('OUTPUT PUT /v2/artifacts/:id versioned', false, 'no artifact.id from create');
  }

  console.log(fails ? '\n✖ OUTPUT ' + fails + ' failed' : '\n★ OUTPUT PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('OUTPUT CRASH', e.message); process.exit(1); });
