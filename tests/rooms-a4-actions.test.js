// A4 TDD — besked-handlinger: replyTo (findes i skemaet, nu UI + API-verificeret),
// regenerate (ask igen med samme session) og copy (UI).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-a4-')), 'gateway.db');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

function makeGateway() {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/25-groups.js'), require('../src/gateway/mounts/146-rooms-ask.js')],
  });
}
function req(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      authorization: 'Bearer tok-op', 'content-type': 'application/json',
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

test('A4: replyTo gemmes på besked-envelope (API-niveau)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', { name: 'a4', bots: ['op'] });
    const roomId = c.body.room.id;
    const p = await req(port, 'POST', `/v2/rooms/${roomId}/messages`, { from: 'op', kind: 'message', body: 'rod-besked' });
    assert.equal(p.status, 201);
    const msgId = p.body.message.id;
    const r = await req(port, 'POST', `/v2/rooms/${roomId}/messages`, { from: 'op', kind: 'message', body: 'svar', replyTo: msgId });
    assert.equal(r.status, 201);
    const d = await req(port, 'GET', `/v2/rooms/${roomId}`);
    const reply = (d.body.room.messages || []).find((m) => m.body === 'svar');
    assert.ok(reply, 'reply found');
    assert.equal(reply.replyTo, msgId, 'replyTo persisted');
  } finally { await new Promise((r) => server.close(r)); }
});

test('A4: rooms-ask svaret bærer replyTo når ask kaldes med replyTo', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', { name: 'a4b', bots: ['op'] });
    const roomId = c.body.room.id;
    const p = await req(port, 'POST', `/v2/rooms/${roomId}/messages`, { from: 'op', kind: 'message', body: 'question root' });
    const msgId = p.body.message.id;
    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, { message: 'hvad?', replyTo: msgId });
    assert.equal(a.status, 200);
    const d = await req(port, 'GET', `/v2/rooms/${roomId}`);
    const asst = (d.body.room.messages || []).find((m) => m.kind === 'assistant');
    assert.ok(asst, 'assistant envelope');
    assert.equal(asst.replyTo, msgId, 'assistant replyTo wired');
  } finally { await new Promise((r) => server.close(r)); }
});

test('A4: UI — reply + regenerate + copy knapper findes i rooms.js (statisk kontrakt)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'rooms.js'), 'utf8');
  assert.match(src, /roommsg-reply/, 'reply-knap i beskedrække');
  assert.match(src, /roommsg-copy/, 'copy-knap i beskedrække');
  assert.match(src, /regenerate|ask igen|askBtn\.click/i, 'regenerate-sti findes');
  // XSS-loven stadig gældende:
  assert.ok(!/innerHTML\s*=/.test(src), 'no innerHTML assignment');
});
