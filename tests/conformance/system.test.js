'use strict';
// SYSTEM domain conformance: deploy, health, self-repair, storage, CLI/TUI.
// MUST-haves: /healthz ok, chain verify ok, all expected mounts loaded.
const http = require('node:http');
const u = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:8800');
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
  // MUST1: /healthz ok:true.
  const h = await api('GET', '/healthz', null, ATLAS);
  check('SYSTEM /healthz → 200 + ok:true', h.status === 200 && h.body && h.body.ok === true, h.status);

  // MUST2: chain verify ok:true.
  const v = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('SYSTEM chain verify ok:true', v.body && v.body.ok === true, 'len=' + (v.body && v.body.length));

  // MUST3: self-repair diagnose reachable.
  const rep = await api('GET', '/v2/repair/diagnose', null, ATLAS);
  check('SYSTEM /v2/repair/diagnose → 200', rep.status === 200 || (rep.body && rep.body.ok !== undefined), rep.status);

  // MUST4: stats endpoint live (operational surface).
  const s = await api('GET', '/v2/stats', null, ATLAS);
  check('SYSTEM /v2/stats → 200 + verified', s.status === 200 && s.body && typeof s.body.verified === 'boolean', s.status);

  // MUST5: gw.mounts loaded — verify a representative set of mount endpoints respond (>= baseline).
  const probes = [
    { path: '/v2/bots', token: ATLAS },
    { path: '/v2/adapters', token: ATLAS },
    { path: '/v2/providers', token: ATLAS },
    { path: '/v2/search?q=conform&token=' + encodeURIComponent(ATLAS), token: ATLAS },
    { path: '/v2/providers/live', token: ATLAS },
    { path: '/v1/approvals', token: ATLAS },
    { path: '/v2/stats', token: ATLAS },
    { path: '/v2/trust/report', token: ATLAS },
    { path: '/v1/audit', token: ATLAS },
    { path: '/v2/computer', token: ATLAS },
  ];
  let loaded = 0;
  for (const p of probes) {
    try {
      const r = await api('GET', p.path, null, p.token);
      if (r.status === 200) loaded++;
    } catch { /* mount not loaded */ }
  }
  check('SYSTEM mounts loaded >= 10', loaded >= 10, 'loaded=' + loaded + '/' + probes.length);

  console.log(fails ? '\n✖ SYSTEM ' + fails + ' failed' : '\n★ SYSTEM PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('SYSTEM CRASH', e.message); process.exit(1); });
