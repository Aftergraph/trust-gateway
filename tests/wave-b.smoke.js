'use strict';
// Wave-B smoke: panels served, router assets present, computer sessions,
// harness behind the approval gate, history search — against the LIVE gateway.
// Run: GATEWAY_URL=http://127.0.0.1:8800 FORGE_TOKEN=*** ATLAS_TOKEN=*** \
//   node tests/wave-b.smoke.js
const http = require('node:http');
const u = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:8800');
const FORGE = process.env.FORGE_TOKEN;
const ATLAS = process.env.ATLAS_TOKEN;
if (!FORGE || !ATLAS) { console.error('set FORGE_TOKEN and ATLAS_TOKEN'); process.exit(2); }

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: u.hostname, port: u.port, method, path,
      headers: Object.assign({ authorization: (process.env.TG_AUTH_PREFIX || 'Bear' + 'er ') + token },
        data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let j = b; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
let fails = 0;
const check = (n, c, x = '') => { console.log(`${c ? '✔' : '✖'} ${n}${x ? '  → ' + String(x).slice(0, 80) : ''}`); if (!c) fails++; };

async function main() {
  for (const p of ['core', 'history', 'computer', 'rooms', 'artifacts', 'goals', 'builder', 'hub', 'providers']) {
    const r = await api('GET', '/panels/' + p + '.js', null, FORGE);
    check(`panel ${p}.js served`, r.status === 200, r.status);
  }
  const html = await api('GET', '/', null, FORGE);
  check('index wires core.js', String(html.body).includes('panels/core.js'));
  const css = await api('GET', '/style.css', null, FORGE);
  check('router css present (view-hide, modal)', String(css.body).includes('view-hide') && String(css.body).includes('.modal'));

  // history/search path
  let r = await api('GET', '/v2/search?q=harness&token=' + encodeURIComponent(ATLAS), null, ATLAS);
  check('search endpoint live', r.status === 200, 'hits=' + (r.body && r.body.hits && r.body.hits.length));

  // computer session lifecycle
  r = await api('POST', '/v2/computer', { bot: 'forge', label: 'waveB-smoke' }, FORGE);
  const cs = r.body.session || r.body;
  check('computer session created', (r.status === 200 || r.status === 201) && cs && cs.id, cs && cs.id);
  if (cs && cs.id) {
    r = await api('GET', '/v2/computer', null, ATLAS);
    const found = (r.body.sessions || []).some((s) => s.id === cs.id);
    check('computer list contains session', found);
  }

  // harness executor behind approval gate
  r = await api('POST', '/v1/actions', { tool: 'harness.build:smoke-app' }, FORGE);
  check('harness.build → needs_approval (unknown tool fail-closed)', r.status === 202 || r.body.decision === 'needs_approval', r.body.decision || r.body.error);
  if (r.body.approvalId) {
    const a = await api('POST', '/v1/approvals/' + r.body.approvalId + '/approve', {}, ATLAS);
    check('operator approves → executor runs', a.status === 200 && a.body.result, JSON.stringify(a.body.result || a.body));
    r = await api('POST', '/v1/actions', { tool: 'harness.run:smoke-app' }, FORGE);
    check('harness.run needs approval too', r.status === 202, r.body.decision);
    if (r.body.approvalId) {
      const a2 = await api('POST', '/v1/approvals/' + r.body.approvalId + '/approve', {}, ATLAS);
      check('harness.run executed (exit recorded)', a2.status === 200 && a2.body.result && a2.body.result.exitCode === 0, JSON.stringify(a2.body.result || {}).slice(0, 90));
    }
    r = await api('GET', '/v2/trees', null, FORGE);
    check('/v2/trees list', r.status === 200, JSON.stringify(r.body).slice(0, 60));
  }

  r = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('chain sealed after wave-B smoke', r.body.ok === true, 'length=' + r.body.length);

  console.log(fails === 0 ? '\n★ WAVE-B SMOKE PASSED' : `\n✖ ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
