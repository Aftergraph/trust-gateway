'use strict';
// H1 TDD — /v2/executions/:workId/evidence returnerer per-item verdicts
// (WORKS G5 evidence_verdicts videresendt) + tampered/fail ALDRIG skjult.
// 131-proxyens /evidence-endpoint er allerede en pass-through; testen
// verificerer at WORKS' evidence_verdicts felt overlever proxyen, og at
// verdicts (ikke kun result) er tilgaengelige for SPA/alarm-koden.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-h1-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const proxy = require('../src/gateway/mounts/131-works-proxy.js');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    fnMounts: [proxy],
  });
}
function req(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    }); r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function boot(gw) {
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, port };
}

test('H1: /v2/executions/:workId/evidence videresender WORKS evidence_verdicts (pass-through)', async () => {
  // Mock WORKS /v1/works/{id}/evidence — bundle top-niveau + verdicts (G5-shape)
  const worksCalls = [];
  const mock = http.createServer((req2, res) => {
    worksCalls.push(req2.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      bundle_id: 'evb_test123',
      work_id: 'wrk_test',
      signatures: [{ alg: 'HS256' }],
      components: { evidence: [{ id: 'ev_1', type: 'build', result: 'pass' }] },
      evidence_verdicts: { ev_1: 'ok', ev_2: 'tampered' },
    }));
  });
  const wPort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));

  process.env.WORKS_API_URL = `http://127.0.0.1:${wPort}`;
  process.env.WORKS_API_TOKEN = 'works-token';

  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'GET', '/v2/executions/wrk_test/evidence', 'tok-op');
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.bundle_id, 'evb_test123', 'bundle pass-through');
    assert.deepEqual(r.body.evidence_verdicts, { ev_1: 'ok', ev_2: 'tampered' },
      'verdicts videresendt til SPA/alarm-koden');
    assert.equal(worksCalls.length, 1);
    assert.match(worksCalls[0], /\/v1\/works\/wrk_test\/evidence/);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    delete process.env.WORKS_API_URL;
    delete process.env.WORKS_API_TOKEN;
  }
});
