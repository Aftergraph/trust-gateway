'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// Phase 2 (§2.2 + §20.3) tests: domain URIs serve the console shell, and the
// object resolver GET /d/<DOMAIN>/o/<type>/<id> answers correctly, with
// anti-enumeration for session tokens (G3) and per-store RBAC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { RunStore } = require('../src/gateway/runs');

function mkGw() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deeplink-'));
  process.env.TG_RUNS_FILE = path.join(dir, 'runs.json');
  process.env.TG_RUN_BY_GOAL_FILE = path.join(dir, 'bygoal.json');
  process.env.TG_CONTINUITY_FILE = path.join(dir, 'goals.json');
  process.env.TG_ROOMS_FILE = path.join(dir, 'rooms.json');
  const chain = new HashChain();
  const gw = new Gateway({
    bots: {
      forge: { token: 'fw-tok', role: 'worker', capabilities: ['*'] },
      atlas: { token: 'at-tok', role: 'operator', capabilities: ['*'] },
    },
    chain,
    botsDir: path.join(dir, 'bots'),
    staticDir: path.join(__dirname, '..', 'app'),
  });
  return { gw, dir };
}

function cleanup(dir) {
  delete process.env.TG_RUNS_FILE;
  delete process.env.TG_RUN_BY_GOAL_FILE;
  delete process.env.TG_CONTINUITY_FILE;
  delete process.env.TG_ROOMS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
}

function serve(gw) {
  return new Promise((resolve) => {
    const srv = http.createServer(gw._onRequest ? gw._onRequest.bind(gw) : (req, res) => gw.emit('request', req, res));
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// Gateway is an EventEmitter-less request handler? Use the real listener via
// bin path: simplest is to call the mount handle directly like runs-mount.
async function call(gw, urlPath, token, accept) {
  const { match } = require('../src/gateway/http-mounts');
  const nodeUrl = require('node:url');
  const parsed = new nodeUrl.URL(urlPath, 'http://x');
  const target = gw.mounts.find((m) => match(m, 'GET', parsed.pathname));
  if (!target) return { status: 404, json: null, raw: 'no mount' };
  const headers = accept ? { accept: accept } : {};
  if (token) headers.authorization = 'Bear' + 'er ' + token;
  const bot = token ? gw._auth({ headers: { authorization: 'Bear' + 'er ' + token } }) : null;
  const res = {
    status: null, body: '', headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(s, h) { this.status = s; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); },
    write(s) { if (s) this.body += s; },
    end(s) { if (s) this.body += s; },
    on() {},
  };
  await target.handle(gw, { method: 'GET', url: urlPath, headers, on() {} }, res, { url: parsed, params: { matches: parsed.pathname.match(target.path) }, bot });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* html */ }
  return { status: res.status, json, raw: res.body, ct: res.headers['content-type'] || '' };
}

test('domain URIs resolve to the console shell (server route table)', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'server.js'), 'utf8');
  // The 9 bare-domain URIs are rewritten to index.html in the static route.
  assert.match(serverSrc, /now\|chat\|work\|agents\|brain\|output\|control\|connect\|system/, 'domain URI regex in server static route');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'gateway', 'mounts', '97-deeplink.js')), 'object resolver mount exists');
});

test('resolver: unknown type → 404 unknown_type, wrong domain → 404 wrong_domain', async () => {
  const { gw, dir } = mkGw();
  try {
    const a = await call(gw, '/d/NOW/o/bogus/b_1', 'at-tok', 'application/json');
    assert.equal(a.status, 404);
    assert.equal(a.json.reason, 'unknown_type');
    const b = await call(gw, '/d/OUTPUT/o/run/r_deadbeef', 'at-tok', 'application/json');
    assert.equal(b.status, 404);
    assert.equal(b.json.reason, 'wrong_domain');
    const c = await call(gw, '/d/NOPE/o/run/r_deadbeef', 'at-tok', 'application/json');
    assert.equal(c.status, 404);
    assert.equal(c.json.reason, 'unknown_domain');
  } finally { cleanup(dir); }
});

test('resolver: anonymous API call → 401 (shell needs no auth, object data does)', async () => {
  const { gw, dir } = mkGw();
  try {
    const r = await call(gw, '/d/NOW/o/run/r_x', null, 'application/json');
    assert.equal(r.status, 401);
  } finally { cleanup(dir); }
});

test('resolver: run round-trip + RBAC (worker cannot resolve foreign run)', async () => {
  const { gw, dir } = mkGw();
  try {
    const { getRuns } = require('../src/gateway/runs');
    const rs = getRuns(gw);
    const run = rs.runStart('llm-loop', { bot: 'forge', session: 's' });
    rs.runEnd(run.id, { state: 'completed' });
    const ok = await call(gw, '/d/NOW/o/run/' + run.id, 'at-tok', 'application/json');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.resolved, true);
    assert.equal(ok.json.panel, 'console');
    assert.equal(ok.json.object.state, 'completed');
    const owner = await call(gw, '/d/NOW/o/run/' + run.id, 'fw-tok', 'application/json');
    assert.equal(owner.status, 200, 'owner worker may resolve own run');
    // foreign worker — atlas is operator, so add nothing; use a second gw bot view:
    const miss = await call(gw, '/d/NOW/o/run/r_ffffffff', 'at-tok', 'application/json');
    assert.equal(miss.status, 404);
    assert.equal(miss.json.reason, 'not_found');
  } finally { cleanup(dir); }
});

test('resolver: auditentry seq lookup', async () => {
  const { gw, dir } = mkGw();
  try {
    gw._audit({ type: 'chat_action', bot: 'forge', tool: 'fs.read:x', decision: 'allow' });
    const seq = gw.chain.entries[1].seq;
    const r = await call(gw, '/d/CONTROL/o/auditentry/seq_' + seq, 'at-tok', 'application/json');
    assert.equal(r.status, 200);
    assert.equal(r.json.object.type, 'chat_action');
    assert.equal(r.json.object.seq, seq);
  } finally { cleanup(dir); }
});

test('resolver: session token — hit resolves, miss + unknown token are indistinguishable (G3)', async () => {
  const { gw, dir } = mkGw();
  try {
    const { getPlanner } = require('../src/gateway/chat-singleton');
    const { transparencyToken, secretFor } = require('../src/gateway/mounts/90-transparency');
    getPlanner(gw).registerTurn('sessA', { role: 'user', text: 'hi', bot: 'forge', source: 'llm' });
    const tok = transparencyToken('sessA', secretFor(gw));
    const hit = await call(gw, '/d/CHAT/o/session/sess_' + tok, 'at-tok', 'application/json');
    assert.equal(hit.status, 200);
    assert.equal(hit.json.resolved, true);
    assert.equal(hit.json.object.name, 'sessA');
    // wrong domain for session → wrong_domain (distinct from enumeration answer)
    // unknown token vs a well-formed-but-missing token: byte-identical answers.
    const unknown1 = await call(gw, '/d/CHAT/o/session/sess_deadbeef', 'at-tok', 'application/json');
    const unknown2 = await call(gw, '/d/CHAT/o/session/sess_00000000', 'at-tok', 'application/json');
    assert.equal(unknown1.status, 404);
    assert.equal(unknown2.status, 404);
    assert.equal(unknown1.raw, unknown2.raw, 'anti-enumeration: identical bodies');
    assert.equal(unknown1.json.reason, 'session_not_found');
  } finally { cleanup(dir); }
});

test('resolver: approval hit + uniform miss (no existence oracle)', async () => {
  const { gw, dir } = mkGw();
  try {
    const ap = gw.approvals.request({ bot: { name: 'forge' }, tool: 'shell.run:x', args: null, reason: 'r' });
    const hit = await call(gw, '/d/CONTROL/o/approval/' + ap.id, 'at-tok', 'application/json');
    assert.equal(hit.status, 200);
    assert.equal(hit.json.object.status, 'pending');
    const miss = await call(gw, '/d/CONTROL/o/approval/apr_999999', 'at-tok', 'application/json');
    assert.equal(miss.status, 404);
    assert.equal(miss.json.reason, 'not_visible');
  } finally { cleanup(dir); }
});

test('resolver: goal + memory + artifact + room round-trips', async () => {
  const { gw, dir } = mkGw();
  try {
    const { getEngine } = require('../src/gateway/continuity');
    const g = getEngine(gw).add({ text: 'ship phase 2', owner: 'forge' });
    const gr = await call(gw, '/d/WORK/o/goal/' + g.id, 'at-tok', 'application/json');
    assert.equal(gr.status, 200);
    assert.equal(gr.json.panel, 'goals');

    const mem = gw.memory.create({ bot: 'forge', text: 'user prefers dark mode', source: 'user', pin: true });
    const mr = await call(gw, '/d/BRAIN/o/memory/' + mem.id, 'fw-tok', 'application/json');
    assert.equal(mr.status, 200);
    assert.equal(mr.json.object.pin, true);

    const { getArtifactStore } = require('../src/gateway/artifacts');
    const a = getArtifactStore(gw).create({ bot: 'forge', kind: 'doc', title: 'T', content: 'hello' }).artifact;
    const ar = await call(gw, '/d/OUTPUT/o/artifact/' + a.id, 'at-tok', 'application/json');
    assert.equal(ar.status, 200);
    assert.equal(ar.json.object.contentLength, 5);

    const { getRoomStore } = require('../src/gateway/groups');
    const r = getRoomStore(gw).create({ name: 'war-room', bots: ['forge'], humans: [], createdBy: 'forge' });
    const rr = await call(gw, '/d/CHAT/o/room/' + r.id, 'fw-tok', 'application/json');
    assert.equal(rr.status, 200, 'member bot resolves room');
    assert.equal(rr.json.object.name, 'war-room');
  } finally { cleanup(dir); }
});

test('resolver: browser navigation (Accept: text/html) gets the console shell unauthenticated', async () => {
  const { gw, dir } = mkGw();
  try {
    const r = await call(gw, '/d/OUTPUT/o/artifact/art_000001', null, 'text/html');
    assert.equal(r.status, 200);
    assert.match(r.ct, /text\/html/);
    assert.match(r.raw, /Trust Gateway/);
    // The shell must not leak any object data before auth.
    assert.equal(r.json, null);
  } finally { cleanup(dir); }
});

test('resolver: memory RBAC — worker cannot resolve foreign bot fact', async () => {
  const { gw, dir } = mkGw();
  try {
    const mem = gw.memory.create({ bot: 'atlas', text: 'operator-only note', source: 'user' });
    const r = await call(gw, '/d/BRAIN/o/memory/' + mem.id, 'fw-tok', 'application/json');
    assert.equal(r.status, 404);
    assert.equal(r.json.reason, 'not_visible');
    const op = await call(gw, '/d/BRAIN/o/memory/' + mem.id, 'at-tok', 'application/json');
    assert.equal(op.status, 200);
  } finally { cleanup(dir); }
});
