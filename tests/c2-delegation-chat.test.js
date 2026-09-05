// C2 TDD — delegation-visualisering i chat: handoff-beskeder viser
// delegation-chain-info inline (fra eksisterende GET /v2/rooms/:id/chain).
// UI-kontrakt: messageRow for kind==='handoff' renderer .roommsg-delegation
// med from→target; chainView (fuldt træ) forbliver på Delegation-tabten.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-c2-deleg-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-file-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

test('C2 API: handoff-envelope bærer target + chain (eksisterende skema, verificeret)', async () => {
  const gw = new Gateway({
    port: 0,
    bots: {
      a: { token: 'tok-a', role: 'worker', capabilities: ['*'] },
      b: { token: 'tok-b', role: 'worker', capabilities: ['*'] },
    },
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/25-groups.js')],
  });
  const server = http.createServer((q, s) => gw.handle(q, s));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
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
    const c = await req('POST', '/v2/rooms', 'tok-a', { name: 'c2', bots: ['a', 'b'] });
    const roomId = c.body.room.id;
    const h = await req('POST', `/v2/rooms/${roomId}/messages`, 'tok-a', {
      from: 'a', kind: 'handoff', body: 'tager den heroppe', target: 'b' });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    const d = await req('GET', `/v2/rooms/${roomId}`, 'tok-a');
    const handoff = (d.body.room.messages || []).find((m) => m.kind === 'handoff');
    assert.ok(handoff, 'handoff envelope');
    assert.equal(handoff.target, 'b');
    assert.ok(Array.isArray(handoff.chain) && handoff.chain.includes('a'), 'chain seeded');
  } finally { await new Promise((r) => server.close(r)); }
});

test('C2 UI: handoff-rækker renderer delegation-badge (statisk kontrakt)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'rooms.js'), 'utf8');
  assert.match(src, /roommsg-delegation/, 'delegation-badge i handoff-række');
  assert.match(src, /handoff-target|m\.target/, 'target vises');
  assert.ok(!/innerHTML\s*=/.test(src), 'no innerHTML');
});
