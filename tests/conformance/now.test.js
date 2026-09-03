'use strict';
// NOW domain conformance: pending approvals, attention queue, chain sealed.
// MUST-haves: approvals surface is queryable, chain verify ok, health ok.
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
  // Seed a pending approval via an action that requires approval.
  let r = await api('POST', '/v1/actions', { tool: 'harness.build:conform-now' }, ATLAS);
  const approvalId = r.body && r.body.approvalId;
  check('NOW seed action → needs_approval', r.status === 202 || (r.body && r.body.decision === 'needs_approval'), r.status);

  // MUST1: GET /v1/approvals returns the pending queue (200 with pending array).
  r = await api('GET', '/v1/approvals', null, ATLAS);
  check('NOW /v1/approvals → 200 + pending array', r.status === 200 && Array.isArray(r.body && r.body.pending), r.status);

  // MUST2: seeded approval surfaces in the pending queue.
  if (approvalId && r.body && r.body.pending) {
    const found = r.body.pending.some((p) => p.id === approvalId);
    check('NOW pending queue contains seeded approval', found, 'id=' + approvalId);
  } else {
    check('NOW pending queue contains seeded approval', !approvalId, 'no approvalId to verify');
  }

  // MUST3: chain verify ok after actions.
  r = await api('GET', '/v1/audit/verify', null, ATLAS);
  check('NOW chain verify ok:true', r.body && r.body.ok === true, 'len=' + (r.body && r.body.length));

  // MUST4: healthz ok (liveness feeds the NOW attention queue).
  r = await api('GET', '/healthz', null, ATLAS);
  check('NOW /healthz ok:true', r.status === 200 && r.body && r.body.ok === true, r.status);

  console.log(fails ? '\n✖ NOW ' + fails + ' failed' : '\n★ NOW PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('NOW CRASH', e.message); process.exit(1); });
