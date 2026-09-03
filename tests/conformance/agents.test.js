'use strict';
// AGENTS domain conformance: bots, builder, roles, teams/rooms.
// MUST-haves: bots directory accessible, agent creation works, rooms fan-out, no token leaks.
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
  // MUST1: GET /v2/bots returns directory — no tokens leaked (ABI rule 5).
  const bots = await api('GET', '/v2/bots', null, ATLAS);
  const botList = bots.body && bots.body.bots || [];
  const tokensLeaked = JSON.stringify(botList).includes('tok') || JSON.stringify(botList).includes('sk-');
  check('AGENTS GET /v2/bots → 200 + no tokens', bots.status === 200 && Array.isArray(botList) && !tokensLeaked, bots.status + ' bots=' + botList.length);

  // MUST2: POST /v2/agents creates an agent (builder).
  const agent = await api('POST', '/v2/agents', { name: 'conform-agent-' + Date.now(), role: 'analyst', persona: 'research' }, FORGE);
  check('AGENTS POST /v2/agents → 200/201', agent.status === 200 || agent.status === 201, agent.status + ' ' + (agent.body && agent.body.agent && agent.body.agent.id || ''));

  // MUST3: POST /v2/rooms creates a room (teams/rooms fan-out).
  const room = await api('POST', '/v2/rooms', { name: 'conform-room-' + Date.now(), bots: ['forge', 'atlas'] }, FORGE);
  const roomId = room.body && (room.body.room || room.body) && ((room.body.room || room.body).id);
  check('AGENTS POST /v2/rooms → 200/201 + room.id', (room.status === 200 || room.status === 201) && !!roomId, room.status + ' ' + (roomId || ''));

  // MUST4: worker cannot escalate to operator (priv-esc regression guard).
  const esc = await api('POST', '/v2/agents', { name: 'rooty', role: 'operator', capabilities: ['*'] }, FORGE);
  check('AGENTS priv-esc rejected for worker', esc.status === 403 || (esc.body && esc.body.error), esc.status);

  console.log(fails ? '\n✖ AGENTS ' + fails + ' failed' : '\n★ AGENTS PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('AGENTS CRASH', e.message); process.exit(1); });
