// B1 TDD — fil-upload i rooms: POST /v2/rooms/:id/attach
// 1) Opretter artifact i artifact-store (kind: doc|code|image-ref)
// 2) Poster attachment-envelope i tråden {kind:'message', body:{attachment:{artifactId,title,name,size}}}
//    (body bliver struktureret — rooms bodyText() stringify'er allerede objekter)
// 3) Fail-closed: ukendt room 404, non-member 403, ugyldig kind/størrelse 400
// 4) Audit: room_attach {roomId, bot, artifactId} — aldrig filindhold
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-attach-')), 'gateway.db');
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
      require('../src/gateway/mounts/25-groups.js'),
      require('../src/gateway/mounts/146-rooms-ask.js'),
      require('../src/gateway/mounts/148-rooms-attach.js'),
      require('../src/gateway/mounts/40-artifacts.js'),
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

test('B1: attach opretter artifact + attachment-envelope i tråden', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'b1', bots: ['op'] });
    const roomId = c.body.room.id;
    const a = await req(port, 'POST', `/v2/rooms/${roomId}/attach`, 'tok-op', {
      name: 'notes.md', content: '# hej\nindhold her', kind: 'doc',
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.ok(a.body.artifactId, 'artifact id returned');
    assert.ok(a.body.messageId, 'attachment message id');

    // tråden har envelope med struktureret body
    const d = await req(port, 'GET', `/v2/rooms/${roomId}`, 'tok-op');
    const msgs = d.body.room.messages || [];
    const att = msgs.find((m) => m.kind === 'message' && m.body && typeof m.body === 'object' && m.body.attachment);
    assert.ok(att, 'attachment envelope i tråden');
    assert.equal(att.body.attachment.artifactId, a.body.artifactId);
    assert.equal(att.body.attachment.name, 'notes.md');
    assert.equal(att.body.attachment.size, Buffer.byteLength('# hej\nindhold her'));

    // artifact findes i artifacts-store med samme indhold
    const art = await req(port, 'GET', `/v2/artifacts/${a.body.artifactId}`, 'tok-op');
    assert.equal(art.status, 200);
    assert.equal(art.body.artifact.content, '# hej\nindhold her');
  } finally { await new Promise((r) => server.close(r)); }
});

test('B1: non-member 403; ukendt room 404', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'b1b', bots: ['op'] });
    const roomId = c.body.room.id;
    const a403 = await req(port, 'POST', `/v2/rooms/${roomId}/attach`, 'tok-w', { name: 'x.txt', content: 'x', kind: 'doc' });
    assert.equal(a403.status, 403);
    const a404 = await req(port, 'POST', '/v2/rooms/room_nope/attach', 'tok-op', { name: 'x.txt', content: 'x', kind: 'doc' });
    assert.equal(a404.status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('B1: ugyldig kind 400; tom content 400; for stor content 400', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'b1c', bots: ['op'] });
    const roomId = c.body.room.id;
    const badKind = await req(port, 'POST', `/v2/rooms/${roomId}/attach`, 'tok-op', { name: 'x', content: 'x', kind: 'virus' });
    assert.equal(badKind.status, 400);
    const empty = await req(port, 'POST', `/v2/rooms/${roomId}/attach`, 'tok-op', { name: 'x', content: '', kind: 'doc' });
    assert.equal(empty.status, 400);
    const tooBig = await req(port, 'POST', `/v2/rooms/${roomId}/attach`, 'tok-op', { name: 'x', content: 'y'.repeat(129 * 1024), kind: 'doc' });
    assert.equal(tooBig.status, 400);
  } finally { await new Promise((r) => server.close(r)); }
});
