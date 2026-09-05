// C4 TDD — session-branching: forgren LLM-sessioner fra et givet punkt.
// POST /v2/chat/llm/branch {session, at, name}
//   at: heltal (0-baseret index i historikken, beskeden INDKLUDERES) eller 'latest'
// Response: {ok, source, branch, messages: n}
// Fail-closed: 400 uden session/name eller ugyldig at; 404 hvis kilde-session tom.
// GATED: kun operator/owner (session-historik er process-tilstand, ikke tenant-data).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-branch-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-branch-rooms-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');
const branchMount = require('../src/gateway/mounts/151-chat-llm-branch.js');

function makeGateway(opts = {}) {
  return new Gateway({
    port: 0,
    bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      w: { token: 'tok-w', role: 'worker', capabilities: ['fs.read'] },
    },
    mountFiles: false,
    mounts: [branchMount],
    ...opts,
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

test('C4: branch mount registreret', () => {
  assert.equal(branchMount.method, 'POST');
  assert.ok(String(branchMount.path).includes('branch'));
});

test('C4: forkast fra index → ny session med historik-slice, uafhængig videre historik', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const { getBrain } = require('../src/gateway/llm-brain');
    const brain = getBrain(gw);
    brain._push('s1', 'user', 'q1');
    brain._push('s1', 'assistant', 'a1');
    brain._push('s1', 'user', 'q2');

    const b = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-op', { session: 's1', at: 1, name: 's1-alt' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.ok, true);
    assert.equal(b.body.messages, 2); // q1 + a1

    // branch-historik eksisterer og er uafhængig
    const hSrc = brain._history('s1');
    const hBr = brain._history('s1-alt');
    assert.equal(hBr.length, 2);
    assert.deepEqual(hBr.map((m) => m.content), ['q1', 'a1']);
    // videre push i kilde ændrer ikke branch
    brain._push('s1', 'user', 'q3');
    assert.equal(brain._history('s1-alt').length, 2);
  } finally { await new Promise((r) => server.close(r)); }
});

test('C4: at=latest + valideringer (404 tom session, 400 ugyldig at, worker 403)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const { getBrain } = require('../src/gateway/llm-brain');
    const brain = getBrain(gw);
    brain._push('s2', 'user', 'u1');

    const latest = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-op', { session: 's2', at: 'latest', name: 's2-b' });
    assert.equal(latest.status, 200);
    assert.equal(latest.body.messages, 1);

    const tom = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-op', { session: 'tom', at: 0, name: 'x' });
    assert.equal(tom.status, 404);

    const badAt = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-op', { session: 's2', at: 99, name: 'x' });
    assert.equal(badAt.status, 400);

    const ugyldig = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-op', { session: 's2', at: 'nope', name: 'x' });
    assert.equal(ugyldig.status, 400);

    const w = await req(port, 'POST', '/v2/chat/llm/branch', 'tok-w', { session: 's2', at: 'latest', name: 'x' });
    assert.equal(w.status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});
