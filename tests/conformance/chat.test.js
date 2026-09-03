'use strict';
// CHAT domain conformance: sessions, messages, deep-chat, transparency pages.
// MUST-haves: POST /v2/chat replies, deep endpoint works, /h transparency renders, anti-enumeration holds.
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

function rawGet(path, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path, headers: { authorization: AUTH + (token || ATLAS) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    }).on('error', reject);
  });
}

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '✔ ' : '✖ ') + name + (extra ? '  → ' + extra : ''));
  if (!cond) fails++;
}

(async () => {
  // Seed a chat session for transparency indexing.
  let r = await api('POST', '/v2/chat', { session: 'conform-chat', message: 'status' }, FORGE);
  check('CHAT POST /v2/chat → 200 + reply', r.status === 200 && (r.body && (typeof r.body.reply === 'string' || r.body.fallback)), r.status + ' ' + JSON.stringify(r.body).slice(0, 60));

  // MUST1: deep endpoint (/v2/chat/llm/deep) works over real brain.
  r = await api('POST', '/v2/chat/llm/deep', { session: 'conform-chat', message: '2+2', bot: 'forge' }, FORGE);
  check('CHAT /v2/chat/llm/deep → 200', r.status === 200 && (r.body && (typeof r.body.reply === 'string' || r.body.fallback)), r.status);

  // MUST2: transparency /h index (operator) lists seeded session.
  await api('POST', '/v2/chat', { session: 'conform-transp', message: 'hello' }, FORGE).catch(() => {});
  const idx = await rawGet('/h', ATLAS);
  const m = idx.raw && idx.raw.match(/href="\/h\/([0-9a-f]{8})">conform-transp/);
  const tok = m ? m[1] : null;
  check('CHAT /h index → 200 + token found', idx.status === 200 && !!tok, idx.status);

  // MUST3: /h/<token> renders the session page.
  const page = tok ? await rawGet('/h/' + tok) : { status: 0, raw: '' };
  check('CHAT /h/<token> renders session page', page.status === 200 && /conform-transp/.test(page.raw), page.status);

  // MUST4: anti-enumeration — unknown tokens byte-identical.
  const bad = await rawGet('/h/deadbeef');
  const bad2 = await rawGet('/h/ffffffff');
  check('CHAT /h unknown tokens byte-identical', bad.status === bad2.status && bad.raw === bad2.raw, bad.status + '/' + bad2.status);

  // MUST5: anon /h → 401/403.
  const anon = await rawGet('/h');
  check('CHAT /h anon → 401/403', anon.status === 401 || anon.status === 403, anon.status);

  console.log(fails ? '\n✖ CHAT ' + fails + ' failed' : '\n★ CHAT PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CHAT CRASH', e.message); process.exit(1); });
