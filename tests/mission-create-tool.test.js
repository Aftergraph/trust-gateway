// E1 TDD — mission.create tool: chat-foreslag -> MissionProposal (governed).
// 1) classify('mission.create:x') = write-klasse (needs_approval for ikke-operator
//    owner-flow — approval-pipelinen ejer godkendelsen)
// 2) Ved approve af et mission.create-foreslag: MissionProposal oprettes med
//    objective + conversion til WORKS via eksisterende approve-path
// 3) Auditor: mission_create_proposed {bot, objectiveLen}
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e1-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e1-rooms-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { classify, decide } = require('../src/gateway/policy');
const { Gateway } = require('../src/gateway/server');

test('E1: mission.create = mission-klasse, needs_approval ALTID (også med capabilities)', () => {
  const cls = classify('mission.create:byg lash-katalog');
  assert.equal(cls, 'mission', 'dedikeret mission-klasse');
  const d = decide({ tool: 'mission.create:byg lash-katalog', cls, bot: { capabilities: ['*'] } });
  assert.equal(d.decision, 'needs_approval', 'capabilities kan ikke auto-godkende missioner');
  assert.match(d.reason, /human approval/i);
});

test('E1: godkendt mission.create-foreslag -> MissionProposal via /v2/proposals', async () => {
  const gw = new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [
      require('../src/gateway/mounts/25-groups.js'),
      require('../src/gateway/mounts/146-rooms-ask.js'),
      require('../src/gateway/mounts/23-missions.js'),
    ],
  });
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  function req(method, p, token, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r2 = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
      }); r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
  }
  try {
    // 1) opret proposal via API (det approval-flowet gør ved godkendt mission.create)
    const p = await req('POST', '/v2/proposals', 'tok-op', {
      proposer: 'op', objective: 'Byg lash-katalog sider', success_criteria: ['sider live'] });
    assert.equal(p.status, 201, JSON.stringify(p.body).slice(0, 120));
    const pid = p.body.proposal.id;

    // 2) submit + approve (operator) — stampede correlation
    const s = await req('POST', `/v2/proposals/${pid}/submit`, 'tok-op', {});
    assert.ok([200, 201].includes(s.status), `submit: ${s.status}`);
    const a = await req('POST', `/v2/proposals/${pid}/approve`, 'tok-op', { approver: 'op' });
    assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 120));
    assert.ok(a.body.proposal.converted_to_mission_id || a.body.proposal.mission_id,
      'mission-correlation stamped');
  } finally { await new Promise((r) => server.close(r)); }
});
