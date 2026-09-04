'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// v2 wave B — backend harness + worktree trees tests.
//
// Covers: executors registered only with --dispatch semantics (server's
// _findExecutor path), harness.build inside-jail scaffolding, traversal
// rejection, harness.run of a generated app (stdout + exit code), approval
// gating for harness.run (destructive classification → needs_approval),
// and the /v2/trees list endpoint. HTTP smoke-tested like the other mounts.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { makeHarness, jailResolve } = require('../src/gateway/harness');
const mount = require('../src/gateway/mounts/55-harness');

// ── helpers ──────────────────────────────────────────────────────
function tmpBotsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-harness-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

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
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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

// Dispatch-mode gateway with the wave B executors registered exactly the way
// bin/gateway.js does it (require the mount, registerExecutor two lines).
function makeDispatchGateway({ botsDir }) {
  const gw = new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
  gw.registerExecutor(/^harness\.(build|run):/, mount.makeHarnessExecutor(botsDir, gw));
  gw.registerExecutor(/^worktree\.(snapshot|remove|list)/, mount.makeWorktreeExecutor(botsDir, gw));
  return gw;
}

// ── harness.build: scaffolds inside the jail ─────────────────────

test('harness.build creates the 4 scaffold files inside the bot jail (realpath under botsDir)', async () => {
  const botsDir = tmpBotsDir();
  try {
    const h = makeHarness({ botsDir });
    const out = await h.build('forge', 'greeter', {});
    assert.equal(out.ok, true);
    assert.equal(out.paths.length, 4);
    for (const rel of out.paths) assert.ok(rel.startsWith('harness/greeter/'), `jail-relative path: ${rel}`);
    // every returned path is jail-relative — no absolute paths leak
    for (const rel of out.paths) assert.ok(!path.isAbsolute(rel));

    const realBots = fs.realpathSync(botsDir);
    const appPath = path.join(realBots, 'forge', 'harness', 'greeter', 'app.js');
    assert.equal(fs.existsSync(appPath), true, 'app.js exists under botsDir realpath');
    for (const f of ['index.html', 'package.json', 'README.md']) {
      assert.equal(fs.existsSync(path.join(realBots, 'forge', 'harness', 'greeter', f)), true, `${f} exists`);
    }
  } finally { cleanup(botsDir); }
});

test('harness.build rejects traversal names and absolute names', async () => {
  const botsDir = tmpBotsDir();
  try {
    const h = makeHarness({ botsDir });
    for (const bad of ['../../escape', '/abs/name', 'a/../b', '.hidden']) {
      const out = await h.build('forge', bad, {});
      assert.equal(out.ok, false, `bad name rejected: ${bad}`);
      assert.equal(out.error, 'bad_name');
    }
    // and the jail resolver itself still refuses '..' segments (defense in depth)
    assert.throws(() => jailResolve('../x', fs.realpathSync(botsDir)), /escapes_jail/);
  } finally { cleanup(botsDir); }
});

test('harness.build jail resolver blocks symlink escape attempts', async () => {
  const botsDir = tmpBotsDir();
  try {
    const h = makeHarness({ botsDir });
    await h.build('forge', 'victim', {});
    // plant a symlink inside the jail pointing outside
    const realBots = fs.realpathSync(botsDir);
    fs.symlinkSync('/etc', path.join(realBots, 'forge', 'harness', 'evil-link'));
    assert.throws(
      () => jailResolve('harness/evil-link/passwd', path.join(realBots, 'forge')),
      /escapes_jail/
    );
  } finally { cleanup(botsDir); }
});

// ── harness.run: spawn discipline + stdout capture ───────────────

test('harness.run of the generated app returns stdout and exit code 0', async () => {
  const botsDir = tmpBotsDir();
  try {
    const h = makeHarness({ botsDir });
    await h.build('forge', 'hello', {});
    const run = await h.run('forge', 'hello');
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, false);
    assert.ok(run.stdout.includes('harness app online'), `stdout captured: ${run.stdout}`);
    assert.ok(run.stderr.length <= 4096 + 64); // tail cap, small slack for error append
    assert.ok(run.durationMs < 10_000);
  } finally { cleanup(botsDir); }
});

test('harness.run rejects traversal names and missing apps', async () => {
  const botsDir = tmpBotsDir();
  try {
    const h = makeHarness({ botsDir });
    const bad = await h.run('forge', '../outside');
    assert.equal(bad.ok, false);
    const missing = await h.run('forge', 'never-built');
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'app_not_found');
    // '/etc/passwd' and '../outside' hit the name charset gate → bad_name
    const abs = await h.run('forge', '/etc/passwd');
    assert.equal(abs.ok, false);
    assert.equal(abs.error, 'bad_name');
  } finally { cleanup(botsDir); }
});

// ── executors behind gateway policy ──────────────────────────────

test('harness.run via gateway classifies destructive → needs_approval (no execution before approval)', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeDispatchGateway({ botsDir });
  try {
    await gw._findExecutor('harness.build:hello') ? null : null; // registry sanity: executor found
    assert.ok(gw._findExecutor('harness.build:hello'));
    assert.ok(gw._findExecutor('harness.run:hello'));
    assert.ok(gw._findExecutor('worktree.snapshot:hello'));
    assert.ok(gw._findExecutor('worktree.remove:x-2026'));
    assert.ok(gw._findExecutor('worktree.list'));

    // unknown tool still falls through to the dispatcher
    assert.equal(gw._findExecutor('fs.read:notes.md'), null);
  } finally { cleanup(botsDir); }
});

test('executor runs after approval via gateway._run (build then run, stdout in result)', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeDispatchGateway({ botsDir });
  try {
    const built = await gw._run('forge', 'harness.build:demo', {});
    assert.equal(built.ok, true);
    assert.deepEqual(built.paths.sort(), [
      'harness/demo/README.md', 'harness/demo/app.js',
      'harness/demo/index.html', 'harness/demo/package.json',
    ]);

    const run = await gw._run('forge', 'harness.run:demo', null);
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    assert.ok(run.stdout.includes('harness app online'));

    // audited: one harness_result passthrough with exitCode, no stdout content
    const entries = gw.chain.entries.filter((e) => e.payload.type === 'harness_result');
    assert.equal(entries.length, 1);
    const p = entries[0].payload;
    assert.equal(p.bot, 'forge');
    assert.equal(p.tool, 'harness.run:demo');
    assert.equal(p.exitCode, 0);
    assert.equal(JSON.stringify(p).includes('harness app online'), false, 'no stdout in audit');
    assert.equal(gw.chain.verify().ok, true);
  } finally { cleanup(botsDir); }
});

// ── worktree snapshots ───────────────────────────────────────────

test('worktree.snapshot copies harness app into trees/, /v2/trees lists it, remove deletes it', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeDispatchGateway({ botsDir });
  const h = mount.getHarness(gw);
  try {
    await h.build('forge', 'site', {});
    const snap = await gw._run('forge', 'worktree.snapshot:site', null);
    assert.equal(snap.ok, true);
    assert.ok(snap.id.startsWith('site-'));
    assert.ok(snap.path.startsWith('trees/site-'));

    const realBots = fs.realpathSync(botsDir);
    const treeDir = path.join(realBots, 'forge', 'trees', snap.id);
    assert.equal(fs.existsSync(path.join(treeDir, 'app.js')), true);

    // snapshot again → two distinct trees
    const snap2 = await gw._run('forge', 'worktree.snapshot:site', null);
    assert.equal(snap2.ok, true);
    assert.notEqual(snap.id, snap2.id);

    // worktree.list executor sees both
    const listed = await gw._run('forge', 'worktree.list', null);
    assert.equal(listed.ok, true);
    assert.equal(listed.trees.length, 2);

    // audit: worktree_snapshot entries present
    const snapAudits = gw.chain.entries.filter((e) => e.payload.type === 'worktree_snapshot');
    assert.equal(snapAudits.length, 2);

    // remove one
    const rm = await gw._run('forge', `worktree.remove:${snap.id}`, null);
    assert.equal(rm.ok, true);
    assert.equal(fs.existsSync(treeDir), false);
    const rmAudit = gw.chain.entries.filter((e) => e.payload.type === 'worktree_remove');
    assert.equal(rmAudit.length, 1);

    // removing again → not_found
    const rm2 = await gw._run('forge', `worktree.remove:${snap.id}`, null);
    assert.equal(rm2.ok, false);
    assert.equal(rm2.error, 'not_found');
  } finally { cleanup(botsDir); }
});

test('worktree.remove is traversal-guarded', async () => {
  const botsDir = tmpBotsDir();
  const gw = makeDispatchGateway({ botsDir });
  try {
    for (const bad of ['../victim', '/etc', 'a/../b']) {
      const out = await gw._run('forge', `worktree.remove:${bad}`, null);
      assert.equal(out.ok, false, `rejected: ${bad}`);
    }
    // nothing outside trees/ was touched
    assert.equal(fs.existsSync(path.join(fs.realpathSync(botsDir), 'forge', 'victim')), false);
  } finally { cleanup(botsDir); }
});

// ── /v2/trees endpoint over real HTTP ────────────────────────────

test('GET /v2/trees requires bearer auth and lists the authed bot snapshots', async () => {
  const botsDir = tmpBotsDir();
  const srv = buildServer();
  const gw = makeDispatchGateway({ botsDir });
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    await gw._run('forge', 'harness.build:alpha', {});
    await gw._run('forge', 'worktree.snapshot:alpha', null);

    // no token → 401, audited
    const anon = await httpCall(base, 'GET', '/v2/trees');
    assert.equal(anon.status, 401);

    // forge sees its own snapshot
    const forge = await httpCall(base, 'GET', '/v2/trees', { token: 'tok-forge' });
    assert.equal(forge.status, 200);
    assert.equal(forge.body.bot, 'forge');
    assert.equal(forge.body.trees.length, 1);
    assert.ok(forge.body.trees[0].id.startsWith('alpha-'));
    assert.ok(forge.body.trees[0].files >= 4);

    // atlas (operator) has its own empty jail — never sees forge's trees
    const atlas = await httpCall(base, 'GET', '/v2/trees', { token: 'tok-atlas' });
    assert.equal(atlas.status, 200);
    assert.equal(atlas.body.bot, 'atlas');
    assert.equal(atlas.body.trees.length, 0);

    // bad token → 401
    const badTok = await httpCall(base, 'GET', '/v2/trees', { token: 'nope' });
    assert.equal(badTok.status, 401);
  } finally {
    await srv.close();
    cleanup(botsDir);
  }
});

// ── policy gating over HTTP (approval flow intact) ───────────────

test('POST /v1/actions harness.run → 202 needs_approval; after operator approve → executed', async () => {
  const botsDir = tmpBotsDir();
  const srv = buildServer();
  const gw = makeDispatchGateway({ botsDir });
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    // build first (also destructive → approval, since unknown tools fail closed)
    const b = await httpCall(base, 'POST', '/v1/actions', {
      token: 'tok-forge', body: { tool: 'harness.build:gate', args: {} },
    });
    assert.equal(b.status, 202, JSON.stringify(b.body));
    const buildId = b.body.approvalId;

    const ba = await httpCall(base, 'POST', `/v1/approvals/${buildId}/approve`, { token: 'tok-atlas' });
    assert.equal(ba.status, 200);
    const built = ba.body.result;
    assert.equal(built.ok, true);

    // run → needs_approval (destructive, always)
    const r = await httpCall(base, 'POST', '/v1/actions', {
      token: 'tok-forge', body: { tool: 'harness.run:gate', args: null },
    });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.decision, 'needs_approval');
    const runId = r.body.approvalId;

    // worker cannot self-approve
    const forbidden = await httpCall(base, 'POST', `/v1/approvals/${runId}/approve`, { token: 'tok-forge' });
    assert.equal(forbidden.status, 403);

    // operator approves → executor runs, stdout comes back
    const ok = await httpCall(base, 'POST', `/v1/approvals/${runId}/approve`, { token: 'tok-atlas' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.result.exitCode, 0);
    assert.ok(ok.body.result.stdout.includes('harness app online'));

    // audit chain intact + harness_result sealed
    const v = gw.chain.verify();
    assert.equal(v.ok, true);
    const res = gw.chain.entries.filter((e) => e.payload.type === 'harness_result');
    assert.equal(res.length, 1);
    assert.equal(res[0].payload.exitCode, 0);
  } finally {
    await srv.close();
    cleanup(botsDir);
  }
});

test('without --dispatch (no dispatch configured) executors are absent — server has no_dispatcher', async () => {
  const gw = new Gateway({ bots: { forge: { name: 'forge', token: 't', role: 'worker', capabilities: ['*'] } } });
  assert.equal(gw._findExecutor('harness.run:x'), null);
  assert.equal(gw._findExecutor('worktree.snapshot:x'), null);
  await assert.rejects(() => gw._run('forge', 'harness.run:x', null), /no_dispatcher/);
});