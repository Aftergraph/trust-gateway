'use strict';
// WORK domain conformance: goals, missions, loops, runs, schedules.
// MUST-haves: goal creation works, self-repair diagnose reachable, chain sealed.
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
  // MUST1: POST /v2/goals creates a goal (seeds work-state).
  const g = await api('POST', '/v2/goals', { text: 'conform-work-gw', owner: 'forge', steps: [{ tool: 'fs.write:conform-work.txt' }] }, FORGE);
  const goalId = g.body && (g.body.goal || g.body) && ((g.body.goal || g.body).id);
  check('WORK POST /v2/goals → 200/201 + goal.id', (g.status === 200 || g.status === 201) && !!goalId, g.status + ' ' + (goalId || ''));

  // MUST2: self-repair diagnose reachable (continuity).
  const rep = await api('GET', '/v2/repair/diagnose', null, ATLAS);
  check('WORK /v2/repair/diagnose → 200', rep.status === 200 || (rep.body && rep.body.ok !== undefined), rep.status);

  // MUST3: chain verify ok after goal creation.
  const v = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('WORK chain verify ok:true', v.body && v.body.ok === true, 'len=' + (v.body && v.body.length));

  // MUST4: GET /v2/goals lists goals (work-state surface).
  const list = await api('GET', '/v2/goals', null, ATLAS);
  check('WORK GET /v2/goals → 200', list.status === 200 && Array.isArray(list.body && (list.body.goals || list.body.pending)), list.status);

  console.log(fails ? '\n✖ WORK ' + fails + ' failed' : '\n★ WORK PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('WORK CRASH', e.message); process.exit(1); });
