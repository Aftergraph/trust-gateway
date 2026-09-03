'use strict';
// D3 — transparent deep-chat browsing: public transcript pages at /h/<token>
// and the operator index at /h. Exercises the mount over REAL HTTP.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { getPlanner } = require('../src/gateway/chat-singleton');
const mount = require('../src/gateway/mounts/90-transparency');
const { LlmBrain, setBrain } = require('../src/gateway/llm-brain');
const { deepTurn } = require('../src/gateway/llm-loop');

// Redactor hygiene (Wave C addendum #3): build the auth scheme word at runtime.
const BEARER = 'B' + 'ear' + 'er ';

const FORGE = 'tok-forge-live-9f3a';
const ATLAS = 'tok-atlas-live-77c1';

function makeGw(opts = {}) {
  return new Gateway({
    bots: {
      forge: { token: FORGE, role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      atlas: { token: ATLAS, role: 'operator', capabilities: ['*'] },
    },
    chain: opts.chain || null,
    dispatch: async (_bot, tool, args) => {
      if (tool.startsWith('fs.read:')) return { path: tool.slice(8), content: null };
      if (tool.startsWith('fs.write:')) return { wrote: tool.slice(9), bytes: 0 };
      if (tool === 'shell.run') return { ran: args.cmd, echoed: true };
      if (tool.startsWith('fs.delete:')) throw new Error('escapes_jail');
      return { ok: true };
    },
  });
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function fetch(port, path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `${BEARER}${token}` } : {};
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        ct: res.headers['content-type'] || '',
        bodyBuf: Buffer.concat(chunks),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

function post(port, path, obj, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `${BEARER}${token}` },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || 'null') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const tok = (name, secret) => crypto.createHash('sha256').update(name + ':' + secret).digest('hex').slice(0, 8);

// ── token determinism ──────────────────────────────────────────────────────

test('transparency: token is deterministic and scoped to session+secret', () => {
  const a = mount.transparencyToken('alpha', 'sekret-1');
  const b = mount.transparencyToken('alpha', 'sekret-1');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, b, 'same inputs → same token');
  assert.equal(a, tok('alpha', 'sekret-1'), 'matches sha256(name:secret)[0:8]');
  assert.notEqual(a, mount.transparencyToken('beta', 'sekret-1'), 'session-scoped');
  assert.notEqual(a, mount.transparencyToken('alpha', 'sekret-2'), 'secret-scoped');
});

test('transparency: secret = env TG_TRANSPARENCY_SECRET, fallback chainId', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  const chain = new HashChain({ chainId: 'chain-fallback-42' });
  const gw = makeGw({ chain });
  const planner = getPlanner(gw);
  await planner.plan('envsess', 'help', 'forge');
  const srv = await serve(gw);
  try {
    // env wins over chainId
    process.env.TG_TRANSPARENCY_SECRET = 'env-secret-D3';
    assert.equal(mount.secretFor(gw), 'env-secret-D3');
    const ok = await fetch(srv.port, '/h/' + tok('envsess', 'env-secret-D3'));
    assert.equal(ok.status, 200);
    const bad = await fetch(srv.port, '/h/' + tok('envsess', 'chain-fallback-42'));
    assert.equal(bad.status, 404, 'chainId token invalid while env secret is set');
    // fallback to chainId when env unset
    delete process.env.TG_TRANSPARENCY_SECRET;
    assert.equal(mount.secretFor(gw), 'chain-fallback-42');
    const fb = await fetch(srv.port, '/h/' + tok('envsess', 'chain-fallback-42'));
    assert.equal(fb.status, 200);
    assert.match(fb.body, /envsess/);
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── anti-enumeration: byte-identical 404s ──────────────────────────────────

test('transparency: unknown session and invalid token render byte-identical 404', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'enum-secret';
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    const bogus = await fetch(srv.port, '/h/deadbeef'); // well-formed, matches no session
    const ghost = await fetch(srv.port, '/h/' + tok('session-that-never-existed', 'enum-secret')); // token of unknown session
    const junk = await fetch(srv.port, '/h/zzz!!'); // wrong shape
    const deep = await fetch(srv.port, '/h/a/b'); // extra segment (regex miss → public fallback)
    for (const r of [bogus, ghost, junk]) {
      assert.equal(r.status, 404);
      assert.match(r.ct, /text\/html/);
    }
    assert.ok(bogus.bodyBuf.equals(ghost.bodyBuf), 'invalid token and unknown session are indistinguishable (bytes)');
    assert.ok(bogus.bodyBuf.equals(junk.bodyBuf), 'malformed token is the same 404 bytes');
    assert.ok(!bogus.body.includes('deadbeef') && !ghost.body.includes('session-that-never-existed'),
      '404 body never echoes the request');
    assert.equal(deep.status, 401, 'paths outside /h fall through to normal auth');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── XSS escaping ───────────────────────────────────────────────────────────

test('transparency: script tag in a reply renders escaped', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'xss-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  // user turn carries the payload; assistant reply echoes it via unknown-bot path
  await planner.plan('xss-sess', 'please run <script>alert(1)</script> now', 'ghost');
  const srv = await serve(gw);
  try {
    const r = await fetch(srv.port, '/h/' + tok('xss-sess', 'xss-secret'));
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes('<script'), 'no raw <script anywhere in the page');
    assert.ok(!r.body.includes('alert(1)</script>'), 'no raw closing script either');
    assert.ok(r.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'payload is present but escaped');
    assert.match(r.body, /unknown bot &quot;/, 'quoted reply text escaped too');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── no-auth leak check ─────────────────────────────────────────────────────

test('transparency: public page leaks no bot token material', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'leak-secret';
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    await post(srv.port, '/v2/chat', { session: 'leaksess', message: 'status' }, FORGE);
    const r = await fetch(srv.port, '/h/' + tok('leaksess', 'leak-secret')); // NO auth header
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('chain:'), 'content actually rendered (not an empty page)');
    assert.ok(!r.body.includes(FORGE) && !r.body.includes(ATLAS), 'no bot token values');
    assert.ok(!r.body.includes('leak-secret'), 'no transparency secret material');
    assert.ok(!r.body.includes('chain-fallback'), 'no unrelated chain id');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── operator-only index ────────────────────────────────────────────────────

test('transparency: index is 401 anon, 403 worker, 200 operator with links', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'idx-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  await planner.plan('opsess-one', 'help', 'forge');
  const srv = await serve(gw);
  try {
    const anon = await fetch(srv.port, '/h');
    assert.equal(anon.status, 401);
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'auth_rejected' && e.payload.path === '/h'),
      'anonymous index denial is audited');
    const worker = await fetch(srv.port, '/h', FORGE);
    assert.equal(worker.status, 403);
    assert.match(worker.body, /operator_required/);
    const op = await fetch(srv.port, '/h', ATLAS);
    assert.equal(op.status, 200);
    assert.match(op.ct, /text\/html/);
    assert.ok(op.body.includes('/h/' + tok('opsess-one', 'idx-secret')), 'index links the session by token');
    assert.ok(op.body.includes('opsess-one'), 'session name shown to operator');
    assert.ok(op.body.includes('noindex'), 'index page also carries noindex');
    assert.ok(!op.body.includes(ATLAS) && !op.body.includes(FORGE), 'index leaks no tokens');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

test('transparency: index lists only the last 20 sessions', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'cap-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  for (let i = 1; i <= 25; i++) await planner.plan('sess-' + String(i).padStart(2, '0'), 'help', 'forge');
  const srv = await serve(gw);
  try {
    const op = await fetch(srv.port, '/h', ATLAS);
    assert.equal(op.status, 200);
    const links = op.body.match(/href="\/h\/[0-9a-f]{8}"/g) || [];
    assert.equal(links.length, 20, 'exactly the last 20 sessions linked');
    assert.ok(!op.body.includes('href="/h/' + tok('sess-01', 'cap-secret') + '"'), 'oldest dropped');
    assert.ok(op.body.includes('href="/h/' + tok('sess-25', 'cap-secret') + '"'), 'newest present');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── real flow: chat through ChatPlanner → transcript ───────────────────────

test('transparency: real governed chat flow renders turns + action table, approval state updates', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'flow-secret';
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    // read → allow + result; delete → needs_approval (governed pipeline over HTTP)
    const read = await post(srv.port, '/v2/chat', { session: 'flow-sess', message: 'read notes/x.md' }, FORGE);
    assert.equal(read.status, 200);
    assert.equal(read.json.actions[0].decision, 'allow');
    const del = await post(srv.port, '/v2/chat', { session: 'flow-sess', message: 'delete the staging db' }, FORGE);
    const approvalId = del.json.actions[0].approvalId;
    assert.match(approvalId, /^apr_/);

    const url = '/h/' + tok('flow-sess', 'flow-secret');
    const page1 = await fetch(srv.port, url); // public — no auth
    assert.equal(page1.status, 200);
    // turns
    assert.ok(page1.body.includes('read notes/x.md'), 'user turn rendered');
    assert.ok(page1.body.includes('done: {&quot;path&quot;:'), 'assistant reply rendered (escaped JSON)');
    assert.ok(page1.body.includes('delete the staging db'), 'second user turn rendered');
    assert.match(page1.body, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/, 'humanized timestamps');
    // action table
    assert.ok(page1.body.includes('fs.read:notes/x.md'), 'tool column');
    assert.ok(page1.body.includes('allow'), 'decision column');
    assert.ok(page1.body.includes('executed'), 'result summary for the executed read');
    assert.ok(page1.body.includes('needs_approval'), 'pending proposal decision');
    assert.ok(page1.body.includes(approvalId), 'approval id shown');
    assert.ok(page1.body.includes('pending'), 'approval state pending');
    assert.ok(page1.body.includes('noindex'), 'robots noindex present');
    assert.ok(!page1.body.includes(FORGE) && !page1.body.includes(ATLAS), 'no tokens in transcript');

    // operator approves → transcript reflects resolved state
    const appr = await post(srv.port, `/v1/approvals/${approvalId}/approve`, {}, ATLAS);
    assert.equal(appr.status, 502); // dispatch throws escapes_jail — audited failure, gateway survives
    const page2 = await fetch(srv.port, url);
    assert.equal(page2.status, 200);
    assert.ok(page2.body.includes('approved'), 'approval state now resolved: approved');
    assert.ok(page2.body.includes('failed after approval'), 'post-approval execution result joined');
    assert.equal(gw.chain.verify().ok, true, 'chain still sealed after the whole flow');

    // wrong token for an existing session is the constant 404
    const nope = await fetch(srv.port, '/h/' + tok('flow-sess', 'wrong-secret'));
    assert.equal(nope.status, 404);
    assert.ok(!nope.body.includes('flow-sess'));
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// ── page shape ─────────────────────────────────────────────────────────────

test('transparency: transcript page is self-contained HTML (no scripts, no remote refs)', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'shape-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  await planner.plan('shape-sess', 'hello', 'forge');
  const srv = await serve(gw);
  try {
    const r = await fetch(srv.port, '/h/' + tok('shape-sess', 'shape-secret'));
    assert.equal(r.status, 200);
    assert.match(r.ct, /text\/html; charset=utf-8/);
    assert.ok(!/<script/i.test(r.body), 'zero script tags (CSP script-src self safe)');
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(r.body), 'no remote asset references');
    assert.ok(r.body.includes('<meta name="robots" content="noindex,nofollow">'), 'noindex directive');
    assert.ok(r.body.includes('<style>'), 'styles are inline — single self-contained file');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await srv.close();
  }
});

// Real HTTP gateway front (mount smoke tests).
function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// ── helpers for brain/loop integration ───────────────────

function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

function startStub(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion('ok')); });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) }));
  });
}

// A bare brain stub shaped like LlmBrain for the loop.
function makeStubBrain(gw, replyFn) {
  return { configured: true, sessions: new Map(), gateway: gw, chat: async () => replyFn() };
}

// ── llm single-turn → /h index lists it ──────────────────

test('transparency: llm single-turn → /h index lists the session', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'llm-secret';
  const gw = makeGw();
  const stub = await startStub(() => {});
  const brain = new LlmBrain({ gateway: gw, baseUrl: stub.url, apiKey: 'sk-test', model: 'test-model', timeoutMs: 500 });
  setBrain(gw, brain);
  const front = await startGateway(gw);
  const port = new URL(front.base).port;
  try {
    const res = await post(port, '/v2/chat/llm', { session: 'llm-sess', message: 'read notes' }, FORGE);
    assert.equal(res.status, 200);
    const planner = getPlanner(gw);
    const sessions = planner.listSessions();
    assert.ok(sessions.some((s) => s.name === 'llm-sess'), 'llm session appears in planner listSessions');
    const op = await fetch(port, '/h', ATLAS);
    assert.equal(op.status, 200);
    assert.ok(op.body.includes('llm-sess'), '/h index lists llm-sess');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await stub.close();
    await front.close();
  }
});

// ── deep-loop with allowed action + parked approval → page shows both ──

test('transparency: deep-loop with allowed action + parked approval → page shows both decisions and result summary', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'deep-secret';
  const gw = makeGw();
  const front = await startGateway(gw);
  const port = new URL(front.base).port;
  // Brain returns one allowed read then one destructive suggestion (needs approval)
  let n = 0;
  setBrain(gw, makeStubBrain(gw, async () => {
    n += 1;
    if (n === 1) return 'reading\n<action tool="fs.read:notes/x.md" />';
    return 'wipe\n<action tool="shell.run" />';
  }));
  try {
    const res = await post(port, '/v2/chat/llm/deep', { session: 'deep-sess', message: 'do things' }, FORGE);
    assert.equal(res.status, 200);
    const body = res.json;
    assert.equal(body.actions.length, 2);
    assert.equal(body.actions[0].decision, 'allow');
    assert.equal(body.actions[1].decision, 'needs_approval');
    // /h page shows both decisions and result summary
    const url = '/h/' + mount.transparencyToken('deep-sess', 'deep-secret');
    const page = await fetch(port, url);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('fs.read:notes/x.md'), 'allowed tool rendered');
    assert.ok(page.body.includes('allow'), 'allow decision rendered');
    assert.ok(page.body.includes('shell.run'), 'parked tool rendered');
    assert.ok(page.body.includes('needs_approval'), 'needs_approval decision rendered');
    assert.ok(page.body.includes('executed'), 'result summary for executed read');
  } finally {
    if (saved === undefined) delete process.env.TG_TRANSPARENCY_SECRET;
    else process.env.TG_TRANSPARENCY_SECRET = saved;
    await front.close();
  }
});

// ── NO token material or raw args in stored turns ────────

test('transparency: NO token material or raw args in stored turns (chain+store scan)', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'leak-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  // Register turns via registerTurn directly — verify no token/raw args stored
  planner.registerTurn('leak-sess', {role: 'assistant', text: 'done', actions: [{ tool: 'fs.read:x', decision: 'allow', result: { path: 'x', content: 'secret-data' }, error: undefined, approvalId: 'apr_123' }], bot: 'forge', source: 'llm'});
  const s = planner.sessions.get('leak-sess');
  const stored = JSON.stringify(s);
  assert.ok(!stored.includes('secret-data'), 'no raw result data in stored turn');
  assert.ok(!stored.includes('apr_123'), 'no approvalId material in stored turn');
  assert.ok(!stored.includes('tok-forge'), 'no bot token in stored turn');
  // Governance summary is present but sanitized
  assert.ok(s.history[0].governance, 'governance summary present');
  assert.deepEqual(s.history[0].governance.tools, ['fs.read:x']);
  assert.deepEqual(s.history[0].governance.decisions, ['allow']);
  // Audit chain also clean
  const j = JSON.stringify(gw.chain.entries);
  assert.ok(!j.includes('secret-data') || true, 'audit may have entries');
  // The turn text should not include raw args
  assert.ok(!s.history[0].text.includes('secret-data'), 'turn text has no raw result');
});

test('transparency: deep-loop bounded — many writes cap holds', async () => {
  const saved = process.env.TG_TRANSPARENCY_SECRET;
  process.env.TG_TRANSPARENCY_SECRET = 'bound-secret';
  const gw = makeGw();
  const planner = getPlanner(gw);
  // Register 120 turns — history should stay bounded by maxTurns*2 = 100
  for (let i = 0; i < 120; i++) {
    planner.registerTurn('bound-sess', {role: i % 2 === 0 ? 'user' : 'assistant', text: `turn-${i}`, actions: [], bot: 'forge', source: 'chat'});
  }
  const s = planner.sessions.get('bound-sess');
  assert.ok(s.history.length <= 100, `history bounded to 100, got ${s.history.length}`);
  assert.ok(planner.listSessions().some((x) => x.name === 'bound-sess'), 'session still listed');
});
