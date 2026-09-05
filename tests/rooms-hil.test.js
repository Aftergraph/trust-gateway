// C3 TDD — GET /v2/rooms/:id/hil: human-in-the-loop kort til rooms-tråden.
// Samler for rummet:
//   - pending approvals (sessionRef room_<roomId> eller alle for room-bots)
//   - need-you items (NOW-projektion, limit 10)
//   - aktive takeovers (principal i room-bots)
// Entry-shape: {type: 'approval'|'needyou'|'takeover', id, summary, actionable}
// Fail-closed: 404 ukendt room, 403 non-member. Ingen syntetiske items.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hil-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hil-rooms-')), 'rooms.json');
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
      require('../src/gateway/mounts/150-rooms-hil.js'),
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

test('C3: HIL-endpoint returnerer tom cards-liste for stille rum (200, ingen syntetiske items)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'c3', bots: ['op'] });
    const roomId = c.body.room.id;
    const h = await req(port, 'GET', `/v2/rooms/${roomId}/hil`, 'tok-op');
    assert.equal(h.status, 200);
    assert.ok(Array.isArray(h.body.cards));
    assert.equal(h.body.cards.length, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test('C3: pending approval lander som actionable card', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'c3b', bots: ['op'] });
    const roomId = c.body.room.id;
    // skab en pending approval via det officielle v1 actions-API (needs_approval-klasse)
    const p = await req(port, 'POST', '/v1/actions', 'tok-op', {
      tool: 'fs.delete:tmp/x', args: { confirm: true } });
    assert.ok([200, 201, 202].includes(p.status), `action park: ${p.status} ${JSON.stringify(p.body).slice(0,120)}`);
    const h = await req(port, 'GET', `/v2/rooms/${roomId}/hil`, 'tok-op');
    assert.equal(h.status, 200);
    const card = (h.body.cards || []).find((x) => x.type === 'approval');
    assert.ok(card, 'approval card present');
    assert.equal(card.actionable, true);
  } finally { await new Promise((r) => server.close(r)); }
});

test('C3: fail-closed — 404 ukendt room', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const h = await req(port, 'GET', '/v2/rooms/room_nope/hil', 'tok-op');
    assert.equal(h.status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
