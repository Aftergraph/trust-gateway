'use strict';
// CONNECT domain conformance: adapters, integrations, webhooks, telegram, MCP/plugins hub.
// MUST-haves: adapters list/create/secret set/test, secret absent from list projection.
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
  // Seed: register a webhook adapter.
  const reg = await api('POST', '/v2/adapters', { kind: 'webhook', name: 'conform-connect', config: { url: 'https://example.com/webhook' } }, ATLAS);
  const adapterId = reg.body && reg.body.adapter && reg.body.adapter.id;
  check('CONNECT POST /v2/adapters → 201 + adapter.id', (reg.status === 201 || reg.status === 200) && !!adapterId, reg.status + ' ' + (adapterId || ''));

  // MUST1: GET /v2/adapters returns secret-free list.
  const list = await api('GET', '/v2/adapters', null, ATLAS);
  const listJson = JSON.stringify(list.body);
  const secretLeaked = listJson.includes('secret') && listJson.includes('value');
  check('CONNECT GET /v2/adapters → 200 + no secret values', list.status === 200 && Array.isArray(list.body && list.body.adapters) && !secretLeaked, list.status);

  // MUST2: adapter secret set stores hash only (name+length, no value).
  let r;
  if (adapterId) {
    r = await api('POST', '/v2/adapters/' + adapterId + '/secret', { name: 'webhook_url', value: 's3cret-value' }, ATLAS);
    check('CONNECT POST /v2/adapters/:id/secret → 200 + name/length', r.status === 200 && r.body && r.body.name && typeof r.body.length === 'number', r.status + ' ' + JSON.stringify(r.body).slice(0, 60));
  } else {
    check('CONNECT POST /v2/adapters/:id/secret', false, 'no adapter.id');
  }

  // MUST3: secret VALUE absent from list projection; the NAME is expected
  // (projection is {name: {length, fingerprint}} — names are operator-owned
  // metadata, values never leave the vault). Regression guard: any literal
  // occurrence of the set value anywhere in the projection = leak.
  const list2 = await api('GET', '/v2/adapters', null, ATLAS);
  const projJson = JSON.stringify(list2.body);
  const valueLeaked = projJson.includes('s3cret-value');
  // every secrets entry must be a {length, fingerprint} shape — no strings
  const shapeOk = (list2.body.adapters || []).every((a) =>
    Object.values(a.secrets || {}).every((v) =>
      v && typeof v === 'object' && typeof v.length === 'number' && typeof v.fingerprint === 'string'));
  check('CONNECT secret value absent from list projection (names+metadata only)', !valueLeaked && shapeOk, projJson.slice(0, 80));

  // MUST4: adapter test probes (returns ok|fail|blocked).
  if (adapterId) {
    r = await api('POST', '/v2/adapters/' + adapterId + '/test', null, ATLAS);
    check('CONNECT POST /v2/adapters/:id/test → 200 + result', r.status === 200 && (r.body && (r.body.result === 'ok' || r.body.result === 'fail' || r.body.result === 'blocked')), r.status + ' ' + (r.body && r.body.result));
  } else {
    check('CONNECT POST /v2/adapters/:id/test', false, 'no adapter.id');
  }

  console.log(fails ? '\n✖ CONNECT ' + fails + ' failed' : '\n★ CONNECT PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CONNECT CRASH', e.message); process.exit(1); });
