'use strict';
// E4 TDD — AIE-lease-visning i missions-panel: leases for en proposal's mission.
// Ny mount: GET /v2/proposals/:id/leases — henter MissionProposal's stamped
// mission_id/correlation, filtrerer /v2/authority leases på mission_id, og
// returnerer { ok, proposalId, missionId, leases }.
// Fail-closed: 404 ukendt proposal, 403 non-operator (authority er operator-only),
// leases utilgængelige → { leases: [], unavailable: true } (ingen syntetiske data).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e4-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e4-rooms-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      w: { token: 'tok-w', role: 'worker', capabilities: ['fs.read'] },
    },
    mountFiles: false,
    mounts: [
      require('../src/gateway/mounts/153-proposal-leases.js'),
      require('../src/gateway/mounts/23-missions.js'),
    ],
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

test('E4: mount registreret', () => {
  const m = require('../src/gateway/mounts/153-proposal-leases.js');
  assert.equal(m.method, 'GET');
  assert.ok(String(m.path).includes('leases'));
});

test('E4: 404 ukendt proposal; 403 worker', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r404 = await req(port, 'GET', '/v2/proposals/prop_nope/leases', 'tok-op');
    assert.equal(r404.status, 404);
    const c = await req(port, 'POST', '/v2/proposals', 'tok-op', { proposer: 'op', objective: 'E4' });
    const pid = c.body.proposal.id;
    const r403 = await req(port, 'GET', `/v2/proposals/${pid}/leases`, 'tok-w');
    assert.equal(r403.status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});

test('E4: proposal uden mission_id → tom leases-liste (ingen syntetiske data)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/proposals', 'tok-op', { proposer: 'op', objective: 'E4b' });
    const pid = c.body.proposal.id;
    const r = await req(port, 'GET', `/v2/proposals/${pid}/leases`, 'tok-op');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.leases, []);
    assert.equal(r.body.missionId, null);
  } finally { await new Promise((r) => server.close(r)); }
});
