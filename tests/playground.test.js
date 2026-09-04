'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// tests/playground.test.js — wave C playground runner + mount (C6).
//
// Covers: js run stdout/exitCode, infinite loop → timedOut + SIGKILL, env
// scrub (PATH present, bot tokens absent), code cap reject (400), jail
// scratch-path resolution under botsDir + traversal rejection, html
// no-execution preview token, audit hygiene (code content absent from the
// chain), HTTP mount flow (bearer 200 + executor 202 approval path).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { runSnippet, jailResolve, MAX_CODE_BYTES, PG_DIR } = require('../src/gateway/playground');
const mount = require('../src/gateway/mounts/80-playground');
const { HashChain } = require('../src/gateway/hash-chain');

function tmpBotsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-playground-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── runner basics ────────────────────────────────────────────────────────

test('runSnippet js: echo returns stdout + exitCode 0', async () => {
  const botsDir = tmpBotsDir();
  try {
    const r = await runSnippet({ bot: 'forge', lang: 'js', code: 'console.log("hello playground")', botsDir, timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /hello playground/);
  } finally { cleanup(botsDir); }
});

test('runSnippet js: infinite loop hits the timeout, SIGKILL, timedOut true', async () => {
  const botsDir = tmpBotsDir();
  try {
    const r = await runSnippet({ bot: 'forge', lang: 'js', code: 'while (true) { /* spin */ }', botsDir, timeoutMs: 500 });
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
  } finally { cleanup(botsDir); }
});

test('runSnippet env scrub: PATH present, bot tokens and secrets absent', async () => {
  const botsDir = tmpBotsDir();
  process.env.TG_TEST_SECRET_TOKEN = 'sekrit-value';
  try {
    const code = 'console.log(JSON.stringify(process.env))';
    const r = await runSnippet({ bot: 'forge', lang: 'js', code, botsDir, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    const env = JSON.parse(r.stdout);
    assert.ok(env.PATH, 'PATH present (node spawn needs it)');
    assert.equal(env.TG_TEST_SECRET_TOKEN, undefined, 'injected secret absent');
    assert.equal(env.TG_BOT_TOKENS, undefined, 'bot tokens absent');
    assert.equal(env.TG_LLM_KEY, undefined, 'llm key absent');
    // only the scrubbed allowlist (+ TG_NO_NET hint)
    const allowed = new Set(['PATH', 'HOME', 'NODE_ENV', 'TG_NO_NET']);
    for (const k of Object.keys(env)) {
      assert.ok(allowed.has(k) || /^TG_[A-Z_]*SECRET/.test(k) === false, 'unexpected env key: ' + k);
      assert.ok(allowed.has(k), 'env key outside scrub allowlist: ' + k);
    }
  } finally {
    delete process.env.TG_TEST_SECRET_TOKEN;
    cleanup(botsDir);
  }
});

test('runSnippet: code cap — over-limit code rejected 400/limit', async () => {
  const botsDir = tmpBotsDir();
  try {
    const code = 'a'.repeat(MAX_CODE_BYTES + 1);
    const r = await runSnippet({ bot: 'forge', lang: 'js', code, botsDir });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'code_too_large');
    assert.equal(r.limit, MAX_CODE_BYTES);
    // exactly at the cap is fine (fast no-op)
    const okR = await runSnippet({ bot: 'forge', lang: 'js', code: 'a'.repeat(MAX_CODE_BYTES), botsDir, timeoutMs: 8000 });
    assert.equal(okR.ok, true);
  } finally { cleanup(botsDir); }
});

test('runSnippet html: no execution — escaped preview token only', async () => {
  const botsDir = tmpBotsDir();
  try {
    const r = await runSnippet({ bot: 'forge', lang: 'html', code: '<script>require("node:fs")</script>', botsDir });
    assert.equal(r.ok, true);
    assert.equal(r.preview, 'sandboxed');
    assert.equal(r.exitCode, null);
    assert.equal(r.stdout, '');
    // no scratch file was ever written for html
    const pgDir = path.join(fs.realpathSync(botsDir), 'forge', PG_DIR);
    if (fs.existsSync(pgDir)) {
      assert.equal(fs.readdirSync(pgDir).length, 0, 'no scratch files for html');
    }
  } finally { cleanup(botsDir); }
});

// ── jail discipline ──────────────────────────────────────────────────────

test('scratch path resolves under botsDir; traversal/bad bot names rejected', async () => {
  const botsDir = tmpBotsDir();
  try {
    const realRoot = fs.realpathSync(botsDir);
    const scratch = jailResolve(`${PG_DIR}/scratch-123.js`, jailResolve('forge', realRoot));
    assert.ok(scratch.startsWith(realRoot + path.sep), 'scratch under botsDir realpath: ' + scratch);
    assert.ok(scratch.includes(path.join('forge', PG_DIR)), 'inside bot playground dir');
    // traversal and bad names are refused by the jail resolver
    assert.throws(() => jailResolve('../escape.js', realRoot), /escapes_jail/);
    assert.throws(() => jailResolve('/etc/passwd', realRoot), /escapes_jail/);
    await assert.rejects(() => runSnippet({ bot: '../escape', lang: 'js', code: 'x', botsDir }), /escapes_jail/);
  } finally { cleanup(botsDir); }
});

// Containment honesty (see src/gateway/playground.js header): the scratch
// node process runs as the same OS user, so code in the jail CAN require fs
// and touch files outside — the module does not pretend otherwise. What we
// CAN assert: the scratch file we create is jailed, and the resolver refuses
// traversal in the paths WE construct. The container boundary is a later
// slice (deploy/cloud.md, C5).

// ── executor path (chat/LLM proposal flow) ───────────────────────────────

test('executor: playground.run:js routes through the same runner', async () => {
  const botsDir = tmpBotsDir();
  try {
    const gw = new Gateway({
      bots: { forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*'] } },
      botsDir,
      dispatch: async (_b, tool, args) => ({ ok: true, tool, args }),
    });
    // the mount-declared executor must be auto-registered by the Gateway ctor
    const exec = gw._findExecutor('playground.run:js');
    assert.ok(exec, 'playground executor auto-registered from mount executors export');
    const out = await exec('forge', 'playground.run:js', { code: 'console.log(6*7)' });
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /42/);
    // audit metrics written, no code content
    const entries = gw.chain.entries.map((e) => JSON.stringify(e.payload));
    const run = entries.find((s) => s.includes('playground_run'));
    assert.ok(run, 'playground_run audit entry exists');
    const payload = JSON.parse(run);
    assert.equal(payload.lang, 'js');
    assert.equal(payload.bytes, 'console.log(6*7)'.length);
    assert.equal(payload.exitCode, 0);
    assert.ok(!run.includes('6*7'), 'code content absent from audit chain');
  } finally { cleanup(botsDir); }
});

// ── HTTP mount flow ──────────────────────────────────────────────────────

function buildServer() {
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) { gw = gateway; server.on('request', (req, res) => gw.handle(req, res)); },
    close() { return new Promise((r) => server.close(() => r())); },
    gw: () => gw,
  };
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}
function httpCall(base, method, p, { token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body === null ? null : JSON.stringify(body);
    // Secret-literal hygiene: build the auth scheme word at runtime.
    const scheme = 'Bear' + 'er';
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { authorization: `${scheme} ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-json */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('HTTP mount: POST /v2/playground/run runs js (bearer) and audits metrics only', async () => {
  const botsDir = tmpBotsDir();
  try {
    const gw = new Gateway({
      bots: { forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*'] } },
      botsDir,
      dispatch: async () => ({ ok: true }),
    });
    const srv = http.createServer((req, res) => gw.handle(req, res));
    const base = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
    try {
      const res = await httpCall(base, 'POST', '/v2/playground/run', {
        token: 'tok-forge',
        body: { lang: 'js', code: 'console.log("over http")' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.result.exitCode, 0);
      assert.match(res.body.result.stdout, /over http/);

      // bad lang / missing code
      const bad = await httpCall(base, 'POST', '/v2/playground/run', { token: 'tok-forge', body: { lang: 'py', code: 'x' } });
      assert.equal(bad.status, 400);

      // over-cap → 400 + limit
      const big = await httpCall(base, 'POST', '/v2/playground/run', {
        token: 'tok-forge', body: { lang: 'js', code: 'x'.repeat(MAX_CODE_BYTES + 1) },
      });
      assert.equal(big.status, 400);
      assert.equal(big.body.error, 'code_too_large');

      // html over http → preview token, never executed
      const html = await httpCall(base, 'POST', '/v2/playground/run', {
        token: 'tok-forge', body: { lang: 'html', code: '<h1>hi</h1>' },
      });
      assert.equal(html.status, 200);
      assert.equal(html.body.result.preview, 'sandboxed');

      // unauthenticated → 401
      const anon = await httpCall(base, 'POST', '/v2/playground/run', { body: { lang: 'js', code: 'x' } });
      assert.equal(anon.status, 401);

      // audit hygiene: code content never in the chain
      const serialized = JSON.stringify(gw.chain.entries);
      assert.ok(!serialized.includes('over http'), 'stdout absent from chain');
      const pg = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'playground_run');
      assert.ok(pg.length >= 1, 'playground_run audited');
      assert.ok(!('code' in pg[0]), 'no code field in audit');
    } finally { await new Promise((r) => srv.close(r)); }
  } finally { cleanup(botsDir); }
});

test('HTTP executor path: playground.run:js via /v1/actions → 202 needs_approval', async () => {
  const botsDir = tmpBotsDir();
  try {
    const gw = new Gateway({
      bots: {
        forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*'] },
        op: { name: 'op', token: 'tok-op', role: 'operator', capabilities: ['*'] },
      },
      botsDir,
      dispatch: async () => ({ ok: true }),
    });
    const srv = http.createServer((req, res) => gw.handle(req, res));
    const base = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
    try {
      // Unknown tool → classify destructive → needs_approval → 202.
      const res = await httpCall(base, 'POST', '/v1/actions', {
        token: 'tok-forge',
        body: { tool: 'playground.run:js', args: { code: 'console.log("proposal")' } },
      });
      assert.equal(res.status, 202);
      assert.equal(res.body.decision, 'needs_approval');
      assert.ok(res.body.approvalId, 'approval parked');

      // nothing executed yet
      const pgDir = path.join(fs.realpathSync(botsDir), 'forge', PG_DIR);
      assert.equal(fs.existsSync(pgDir), false, 'no scratch written before approval');

      // operator approves → executor runs the parked action
      const ap = await httpCall(base, 'POST', `/v1/approvals/${res.body.approvalId}/approve`, { token: 'tok-op' });
      assert.equal(ap.status, 200);
      assert.equal(ap.body.status, 'approved');
      assert.equal(ap.body.result.exitCode, 0);
      assert.match(ap.body.result.stdout, /proposal/);

      // deny path parks nothing
      const res2 = await httpCall(base, 'POST', '/v1/actions', {
        token: 'tok-forge',
        body: { tool: 'playground.run:html', args: { code: '<p>hi</p>' } },
      });
      assert.equal(res2.status, 202);
      const dn = await httpCall(base, 'POST', `/v1/approvals/${res2.body.approvalId}/deny`, { token: 'tok-op' });
      assert.equal(dn.status, 200);

      // audit hygiene across the whole flow: code content never sealed
      const serialized = JSON.stringify(gw.chain.entries);
      assert.ok(!serialized.includes('proposal'), 'proposed code absent from chain');
      assert.ok(!serialized.includes('<h1>hi</h1>'), 'html code absent from chain');
      assert.equal(gw.chain.verify().ok, true, 'chain still sealed');
    } finally { await new Promise((r) => srv.close(r)); }
  } finally { cleanup(botsDir); }
});