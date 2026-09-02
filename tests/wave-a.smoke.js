'use strict';
// Wave-A smoke: exercises every module the 10 agents built, against the LIVE
// gateway over real HTTP. Run: FORGE_TOKEN=*** ATLAS_TOKEN=*** \
//   GATEWAY_URL=http://127.0.0.1:8800 node tests/wave-a.smoke.js
const http = require('node:http');

const BASE = process.env.GATEWAY_URL || 'http://100.71.253.52:8800';
const FORGE = process.env.FORGE_TOKEN;
const ATLAS = process.env.ATLAS_TOKEN;
if (!FORGE || !ATLAS) { console.error('set FORGE_TOKEN and ATLAS_TOKEN'); process.exit(2); }

const u = new URL(BASE);
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: u.hostname, port: u.port, method, path,
      headers: Object.assign(
        { authorization: 'Bearer ' + token },
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { j = b; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✖'} ${name}${extra ? '  → ' + String(extra).slice(0, 90) : ''}`);
  if (!cond) fails++;
};

async function main() {
  // W6 providers
  let r = await api('GET', '/v2/providers', null, ATLAS);
  check('W6 providers registry', r.status === 200 && JSON.stringify(r.body).includes('dialagram'),
    Array.isArray(r.body.providers) ? r.body.providers.length + ' providers' : r.body);
  r = await api('POST', '/v2/providers/plan', { task: 'write code', preferFree: true }, ATLAS);
  check('W6 free-first plan', r.status === 200, JSON.stringify(r.body).slice(0, 60));

  // W2 groups
  r = await api('POST', '/v2/rooms', { name: 'launch', bots: ['forge', 'atlas'] }, FORGE);
  const room = r.body && (r.body.room || r.body);
  check('W2 room created', r.status === 200 || r.status === 201, room && room.id);
  if (room && room.id) {
    r = await api('POST', `/v2/rooms/${room.id}/messages`,
      { from: 'forge', body: '@atlas status?' }, FORGE);
    check('W2 mention fan-out', r.status < 500, JSON.stringify(r.body).slice(0, 70));
  }

  // W3 builder (unique name — store is durable, 409 on repeat is correct)
  r = await api('POST', '/v2/agents', { name: 'scout-' + Date.now(), role: 'analyst', persona: 'research' }, FORGE);
  check('W3 custom agent created', r.status === 200 || r.status === 201, r.body && r.body.agent && r.body.agent.name);
  r = await api('POST', '/v2/agents', { name: 'rooty', role: 'operator', capabilities: ['*'] }, FORGE);
  check('W3 priv-esc rejected for worker', r.status === 403 || (r.body && r.body.error), r.status);

  // W4 plugins hub
  r = await api('GET', '/v2/skills', null, ATLAS);
  check('W4 skills hub', r.status === 200, JSON.stringify(r.body).slice(0, 50));
  r = await api('GET', '/v2/mcp', null, ATLAS);
  check('W4 mcp registry', r.status === 200);

  // W5 artifacts + computer
  r = await api('POST', '/v2/artifacts', { kind: 'doc', title: 'report', content: 'v1', bot: 'forge' }, FORGE);
  const art = r.body && (r.body.artifact || r.body);
  check('W5 artifact created', (r.status === 200 || r.status === 201) && art && art.id, art && art.id);
  if (art && art.id) {
    r = await api('PUT', `/v2/artifacts/${art.id}`, { content: 'v2', bot: 'forge' }, FORGE);
    check('W5 artifact versioned', r.status === 200 && /version/.test(JSON.stringify(r.body)));
  }
  r = await api('POST', '/v2/computer', { bot: 'forge', label: 'release' }, FORGE);
  const cs = r.body && (r.body.session || r.body);
  check('W5 computer session', (r.status === 200 || r.status === 201) && cs && cs.id, cs && cs.id);

  // W10 continuity
  r = await api('POST', '/v2/goals', { text: 'ship launch', owner: 'forge', steps: [{ tool: 'fs.write:plan.md' }] }, FORGE);
  const g = r.body && (r.body.goal || r.body);
  check('W10 goal created', (r.status === 200 || r.status === 201) && g && g.id, g && g.id);
  r = await api('GET', '/v2/repair/diagnose', null, ATLAS);
  check('W10 self-repair diagnose', r.status === 200 || (r.body && r.body.ok !== undefined), JSON.stringify(r.body).slice(0, 50));

  // W1 LLM (no env configured on live server → fallback contract)
  r = await api('POST', '/v2/chat/llm', { session: 'smoke', message: 'hello' }, FORGE);
  check('W1 llm mount present', r.status === 200 && (r.body.fallback === true || r.body.reply), JSON.stringify(r.body).slice(0, 60));

  // W9 PWA assets (wired in wave B)
  r = await api('GET', '/manifest.webmanifest', null, FORGE);
  check('W9 manifest served', r.status === 200, r.status);
  r = await api('GET', '/sw.js', null, FORGE);
  check('W9 sw.js served', r.status === 200, r.status);
  r = await api('GET', '/home', null, FORGE);
  check('W8 marketing at /home', r.status === 200 && String(JSON.stringify(r.body)).length > 0 || r.status === 200, r.status);

  // chain overall
  r = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('chain sealed after full smoke', r.body && r.body.ok === true, r.body && `length=${r.body.length}`);

  console.log(fails === 0 ? '\n★ WAVE-A SMOKE PASSED' : `\n✖ ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
