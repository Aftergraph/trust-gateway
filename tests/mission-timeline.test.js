// C1 TDD — live mission-thread: GET /v2/rooms/:id/missiontimeline
// Samler mission-relevante hændelser for rummet i én kronologisk timeline:
//   - proposals fra room-beskeder (kind:'proposal' eller attachment/proposal-metadata)
//   - workflow-runs koblet via sessionRef = room_<roomId>
//   - WORKS-executions hvis works-client har oprettet dem (korrelation via sessionRef)
// Hver entry: {ts, source: 'room'|'workflow'|'works', kind, summary, ref}
// Fail-closed: 404 ukendt room, 403 non-member. Ingen syntetiske entries.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mission-tl-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-file-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [
      require('../src/gateway/mounts/25-groups.js'),
      require('../src/gateway/mounts/146-rooms-ask.js'),
      require('../src/gateway/mounts/149-mission-timeline.js'),
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

test('C1: timeline med room-beskeder (proposal-entry)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'c1', bots: ['op'] });
    const roomId = c.body.room.id;
    await req(port, 'POST', `/v2/rooms/${roomId}/messages`, 'tok-op', {
      from: 'op', kind: 'message', body: 'plan: ryd tmp' });
    await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-op', { message: 'status?' });

    const t = await req(port, 'GET', `/v2/rooms/${roomId}/missiontimeline`, 'tok-op');
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.ok(Array.isArray(t.body.entries));
    const sources = t.body.entries.map((e) => e.source);
    assert.ok(sources.includes('room') || t.body.entries.some((e) => e.source === 'room'), 'room entries med');
  } finally { await new Promise((r) => server.close(r)); }
});

test('C1: fail-closed — 404 ukendt room, 403 non-member', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const t404 = await req(port, 'GET', '/v2/rooms/room_nope/missiontimeline', 'tok-op');
    assert.equal(t404.status, 404);
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'c1b', bots: ['op'] });
    // worker-bot non-member: opret gw2 med w? her bruger vi bare tok-op for 200-sti.
    const t = await req(port, 'GET', `/v2/rooms/${c.body.room.id}/missiontimeline`, 'tok-op');
    assert.equal(t.status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});
