'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// FS-C2 — harness v2 tests: project model, jailed build/run, approval gate.
//
// Covers: create→build→run happy path (hello world), timeout SIGKILL, path
// traversal rejection, 256 KB size cap, env scrub (a child printing its
// process.env keys finds PATH/HOME/NODE_ENV only — no secrets), the
// requiresApproval gate (run parks in gw.approvals; executes only after
// operator approval), and RBAC (operator / cap 'harness.run' / plain worker).
// HTTP exercised through a real server like the other mount tests.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { makeHarness2, slugify, validateRelPath } = require('../src/gateway/harness2');
const mount = require('../src/gateway/mounts/106-harness2');

// ── helpers ──────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-harness2-'));
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

// Bots: atlas = operator; builder = worker WITH the harness.run cap;
// forge = plain worker (no harness caps). gw.botsDir sits under a tmpdir so
// dataDirFor() resolves the harness2 store to <tmpdir>/harness2.
function makeGateway(tmp) {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      builder: { name: 'builder', token: 'tok-builder', role: 'worker', capabilities: ['harness.run'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: [] },
    },
    botsDir: path.join(tmp, 'bots'),
  });
}

const HELLO = { 'app.js': "console.log('hello from harness2');" };

// ── core: happy path create→build→run ────────────────────────────

test('harness2: create → build → run happy path (hello world, jailed)', async () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    const c = h.createProject({ name: 'Hello World', files: HELLO });
    assert.equal(c.ok, true);
    assert.equal(c.project.id, 'hello-world');
    assert.equal(c.project.entry, 'app.js');
    assert.equal(c.fileCount, 1);

    // project layout on disk
    const root = fs.realpathSync(path.join(tmp, 'harness2', 'hello-world'));
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'files', 'app.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'jail')), false, 'no jail before build');

    const b = h.buildProject('hello-world');
    assert.equal(b.ok, true);
    assert.equal(b.fileCount, 1);
    assert.equal(fs.existsSync(path.join(root, 'jail', 'app.js')), true, 'jail copy exists');

    const run = await h.runProject('hello-world');
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, false);
    assert.ok(run.stdout.includes('hello from harness2'));
    assert.ok(run.durationMs < 10_000);
  } finally { cleanup(tmp); }
});

test('harness2: rebuild is a clean jail copy (stale file gone)', async () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    h.createProject({ name: 'Stale', files: { 'app.js': 'console.log(1);', 'old.js': '// old' } });
    h.buildProject('stale');
    const root = path.join(fs.realpathSync(path.join(tmp, 'harness2', 'stale')), 'jail');
    assert.equal(fs.existsSync(path.join(root, 'old.js')), true);
    // remove from source, rebuild → stale file must not survive
    fs.rmSync(path.join(fs.realpathSync(path.join(tmp, 'harness2', 'stale')), 'files', 'old.js'));
    const b2 = h.buildProject('stale');
    assert.equal(b2.ok, true);
    assert.equal(fs.existsSync(path.join(root, 'old.js')), false);
  } finally { cleanup(tmp); }
});

// ── core: timeout SIGKILL ────────────────────────────────────────

test('harness2: runaway entry is SIGKILLed at the configured timeout', async () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2'), runTimeoutMs: 300 });
    h.createProject({ name: 'Loop', files: { 'app.js': 'while (true) { /* spin */ }' } });
    h.buildProject('loop');
    const run = await h.runProject('loop');
    assert.equal(run.ok, true);
    assert.equal(run.timedOut, true);
    assert.equal(run.exitCode, null);
    assert.ok(run.durationMs >= 250 && run.durationMs < 5000, `duration ${run.durationMs}`);
  } finally { cleanup(tmp); }
});

// ── core: validation (slug, entry, skills-as-warnings) ──────────

test('harness2: bad names, bad entry and bad skills are rejected at create', () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    assert.equal(h.createProject({ name: '!!!', files: HELLO }).error, 'bad_name');
    assert.equal(h.createProject({ name: '', files: HELLO }).error, 'bad_name');
    assert.equal(h.createProject({ name: 'X', files: {} }).error, 'bad_files');
    assert.equal(h.createProject({ name: 'No Entry', files: { 'readme.md': 'hi' } }).error, 'entry_missing');
    assert.equal(
      h.createProject({ name: 'Bad Entry', files: HELLO, entry: 'missing.js' }).error,
      'entry_missing',
    );
    assert.equal(h.createProject({ name: 'Sk', files: HELLO, skills: 'x' }).error, 'bad_skills');
    assert.equal(h.createProject({ name: 'Sk', files: HELLO, skills: ['UPPER'] }).error, 'bad_skills');
  } finally { cleanup(tmp); }
});

test('harness2: unknown skill ids are warnings, not errors; known ones pass silently', () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({
      dataDir: path.join(tmp, 'harness2'),
      knownSkills: ['weather.lookup'],
    });
    const c = h.createProject({ name: 'Skilled', files: HELLO, skills: ['weather.lookup', 'nope.unknown'] });
    assert.equal(c.ok, true);
    assert.deepEqual(c.warnings, ['unknown_skill:nope.unknown']);
    const v = h.validateProject('skilled');
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, ['unknown_skill:nope.unknown']);
    assert.deepEqual(v.errors, []);
    // with an empty registry every declared skill warns (documented default)
    const h2 = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    const v2 = h2.validateProject('skilled');
    assert.deepEqual(v2.warnings, ['unknown_skill:weather.lookup', 'unknown_skill:nope.unknown']);
  } finally { cleanup(tmp); }
});

test('harness2: validateProject reports structural errors, not_found on missing id', () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    assert.deepEqual(h.validateProject('ghost').errors, ['not_found']);
    h.createProject({ name: 'Fine', files: HELLO });
    const v = h.validateProject('fine');
    assert.equal(v.ok, true);
    // corrupt the manifest entry → structural error
    const mPath = path.join(tmp, 'harness2', 'fine', 'manifest.json');
    fs.writeFileSync(mPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(mPath, 'utf8')), entry: 'gone.js' }));
    const v2 = h.validateProject('fine');
    assert.equal(v2.ok, false);
    assert.deepEqual(v2.errors, ['entry_missing']);
    // build refuses invalid projects
    assert.equal(h.buildProject('fine').error, 'invalid_project');
  } finally { cleanup(tmp); }
});

test('harness2: slugify + validateRelPath unit behavior', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('  --Weird__Name--  '), 'weird-name');
  assert.equal(slugify('///'), '');
  for (const bad of ['../evil.js', '/abs/x.js', 'a/../b.js', 'a//b.js', '', 'a\\b.js', 'x\0.js']) {
    assert.equal(validateRelPath(bad), 'bad_path', `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(validateRelPath('lib/util.js'), null);
});

// ── HTTP surface ─────────────────────────────────────────────────

test('POST /v2/harness2/projects → 201 → build → run over real HTTP (audit rows 106/107)', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  const gw = makeGateway(tmp);
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    const c = await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-builder', body: { name: 'Hello World', files: HELLO },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.id, 'hello-world');

    // duplicate slug → 409
    const dup = await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-atlas', body: { name: 'hello world', files: HELLO },
    });
    assert.equal(dup.status, 409);

    // GET list + read-one
    const list = await httpCall(base, 'GET', '/v2/harness2/projects', { token: 'tok-forge' });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    const one = await httpCall(base, 'GET', '/v2/harness2/projects/hello-world', { token: 'tok-forge' });
    assert.equal(one.status, 200);
    assert.equal(one.body.project.entry, 'app.js');
    const ghost = await httpCall(base, 'GET', '/v2/harness2/projects/ghost', { token: 'tok-forge' });
    assert.equal(ghost.status, 404);

    // build then run (worker with the cap may do both)
    const b = await httpCall(base, 'POST', '/v2/harness2/projects/hello-world/build', { token: 'tok-builder' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.fileCount, 1);
    const r = await httpCall(base, 'POST', '/v2/harness2/projects/hello-world/run', { token: 'tok-builder' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.exitCode, 0);
    assert.ok(r.body.stdout.includes('hello from harness2'));

    // run without a prior build → 409 not_built
    await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-atlas', body: { name: 'Never Built', files: HELLO },
    });
    const nb = await httpCall(base, 'POST', '/v2/harness2/projects/never-built/run', { token: 'tok-atlas' });
    assert.equal(nb.status, 409);
    assert.equal(nb.body.error, 'not_built');

    // transparency rows: harness2_project_created + harness2_run, minimal payloads
    const created = gw.chain.entries.filter((e) => e.payload.type === 'harness2_project_created');
    assert.equal(created.length, 2);
    assert.equal(created[0].payload.id, 'hello-world');
    assert.equal(created[0].payload.fileCount, 1);
    const runs = gw.chain.entries.filter((e) => e.payload.type === 'harness2_run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].payload.id, 'hello-world');
    assert.equal(runs[0].payload.ok, true);
    assert.equal(runs[0].payload.exitCode, 0);
    assert.equal(typeof runs[0].payload.durationMs, 'number');
    assert.equal(JSON.stringify(runs[0].payload).includes('hello from'), false, 'no stdout in chain');
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    await srv.close();
    cleanup(tmp);
  }
});

test('path traversal in the files map is rejected (400, nothing written)', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  const gw = makeGateway(tmp);
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    for (const bad of ['../evil.js', '/etc/cron.d/evil', 'lib/../../evil.js']) {
      const r = await httpCall(base, 'POST', '/v2/harness2/projects', {
        token: 'tok-atlas', body: { name: `Evil ${bad.replace(/\W+/g, ' ')}`, files: { [bad]: 'x' } },
      });
      assert.equal(r.status, 400, `traversal rejected: ${bad}`);
      assert.equal(r.body.error, 'bad_path');
    }
    // nothing escaped the store
    assert.equal(fs.existsSync(path.join(tmp, 'evil.js')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'etc')), false);
  } finally {
    await srv.close();
    cleanup(tmp);
  }
});

test('source size cap: total over 256 KB rejected (core cap, 413 over HTTP)', async () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    const big = 'x'.repeat(200 * 1024);
    const r = h.createProject({ name: 'Too Big', files: { 'a.js': big, 'b.js': big } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'size_cap');
    assert.ok(r.totalBytes > 256 * 1024);
    assert.equal(fs.existsSync(path.join(tmp, 'harness2', 'too-big')), false, 'nothing written');
    // just under the cap is fine
    const ok = h.createProject({
      name: 'Just Fits',
      files: { 'a.js': 'y'.repeat(190 * 1024), 'notes.md': 'y'.repeat(60 * 1024) }, // 256,000 ≤ 262,144
    });
    assert.equal(ok.ok, true);
    // HTTP layer: a payload beyond the gateway's own 256 KB body cap is
    // rejected before the mount sees it (readBody destroys the socket).
    const srv = buildServer();
    const gw = makeGateway(tmp);
    srv.attach(gw);
    const base = await listen(srv.server);
    try {
      let result = null;
      try {
        result = await httpCall(base, 'POST', '/v2/harness2/projects', {
          token: 'tok-atlas', body: { name: 'Huge', files: { 'a.js': big, 'b.js': big } },
        });
      } catch { /* ECONNRESET is the acceptable outcome of the body cap */ }
      assert.ok(result === null || result.status >= 400, 'oversized HTTP body never yields 201');
    } finally {
      await srv.close();
    }
  } finally { cleanup(tmp); }
});

test('env scrub: the jailed child sees PATH/HOME/NODE_ENV only — no secrets', async () => {
  const tmp = tmpDir();
  process.env.HARNESS2_TEST_SECRET = 'super-secret-value';
  process.env.HARNESS2_TEST_TOKEN = 'tok-should-not-leak';
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    h.createProject({
      name: 'Env Spy',
      files: { 'app.js': "console.log(JSON.stringify(Object.keys(process.env).sort())); console.log(JSON.stringify(process.env.NODE_ENV));" },
    });
    h.buildProject('env-spy');
    const run = await h.runProject('env-spy');
    assert.equal(run.exitCode, 0);
    const keys = JSON.parse(run.stdout.split('\n')[0]);
    assert.deepEqual(keys, ['HOME', 'NODE_ENV', 'PATH']);
    const nodeEnv = JSON.parse(run.stdout.split('\n')[1]);
    assert.equal(nodeEnv, 'production');
    assert.equal(run.stdout.includes('super-secret-value'), false, 'secret value never reaches the child');
    assert.equal(run.stdout.includes('tok-should-not-leak'), false, 'token never reaches the child');
  } finally {
    delete process.env.HARNESS2_TEST_SECRET;
    delete process.env.HARNESS2_TEST_TOKEN;
    cleanup(tmp);
  }
});

// ── approval gate ────────────────────────────────────────────────

test('requiresApproval=true: run parks in approvals; operator approve executes the jailed run', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  const gw = makeGateway(tmp);
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    const c = await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-atlas',
      body: { name: 'Gated', files: HELLO, requiresApproval: true },
    });
    assert.equal(c.status, 201);
    assert.equal(c.body.project.requiresApproval, true);
    await httpCall(base, 'POST', '/v2/harness2/projects/gated/build', { token: 'tok-atlas' });

    // run → parked, NOT executed
    const r = await httpCall(base, 'POST', '/v2/harness2/projects/gated/run', { token: 'tok-builder' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.decision, 'needs_approval');
    const approvalId = r.body.approvalId;
    const parked = gw.approvals.get(approvalId);
    assert.equal(parked.status, 'pending');
    assert.equal(parked.tool, 'harness2.run:gated');
    assert.equal(gw.chain.entries.some((e) => e.payload.type === 'harness2_run'), false, 'no execution row yet');

    // worker cannot self-approve
    const forbidden = await httpCall(base, 'POST', `/v1/approvals/${approvalId}/approve`, { token: 'tok-builder' });
    assert.equal(forbidden.status, 403);

    // operator approves → executor runs the jailed entry, result returned
    const ok = await httpCall(base, 'POST', `/v1/approvals/${approvalId}/approve`, { token: 'tok-atlas' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.result.exitCode, 0);
    assert.ok(ok.body.result.stdout.includes('hello from harness2'));

    // exactly one harness2_run row, emitted by the executor path
    const runs = gw.chain.entries.filter((e) => e.payload.type === 'harness2_run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].payload.id, 'gated');
    assert.equal(runs[0].payload.exitCode, 0);
    assert.equal(gw.chain.verify().ok, true);

    // a second run parks again (the gate never lapses)
    const r2 = await httpCall(base, 'POST', '/v2/harness2/projects/gated/run', { token: 'tok-atlas' });
    assert.equal(r2.status, 202);
  } finally {
    await srv.close();
    cleanup(tmp);
  }
});

// ── RBAC ─────────────────────────────────────────────────────────

test('RBAC: plain worker 403 on create/build/run; cap harness.run and operator allowed; anon 401', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  const gw = makeGateway(tmp);
  srv.attach(gw);
  const base = await listen(srv.server);
  try {
    // no token → 401
    const anon = await httpCall(base, 'GET', '/v2/harness2/projects');
    assert.equal(anon.status, 401);

    // forge (no harness caps): 403 + approval_forbidden audit
    const c = await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-forge', body: { name: 'Denied', files: HELLO },
    });
    assert.equal(c.status, 403);
    assert.equal(gw.chain.entries.filter((e) => e.payload.type === 'approval_forbidden').length >= 1, true);

    // builder has the cap → create works; forge still can't touch it
    const ok = await httpCall(base, 'POST', '/v2/harness2/projects', {
      token: 'tok-builder', body: { name: 'Cap Run', files: HELLO },
    });
    assert.equal(ok.status, 201);
    const deniedBuild = await httpCall(base, 'POST', '/v2/harness2/projects/cap-run/build', { token: 'tok-forge' });
    assert.equal(deniedBuild.status, 403);
    const deniedRun = await httpCall(base, 'POST', '/v2/harness2/projects/cap-run/run', { token: 'tok-forge' });
    assert.equal(deniedRun.status, 403);
    const allowedBuild = await httpCall(base, 'POST', '/v2/harness2/projects/cap-run/build', { token: 'tok-builder' });
    assert.equal(allowedBuild.status, 200);
    const allowedRun = await httpCall(base, 'POST', '/v2/harness2/projects/cap-run/run', { token: 'tok-atlas' });
    assert.equal(allowedRun.status, 200);

    // reads are bearer-authenticated but not operator-gated
    const forgeRead = await httpCall(base, 'GET', '/v2/harness2/projects', { token: 'tok-forge' });
    assert.equal(forgeRead.status, 200);
  } finally {
    await srv.close();
    cleanup(tmp);
  }
});

test('executor is auto-registered by the mount (wave C convention, bin untouched)', () => {
  const tmp = tmpDir();
  try {
    const gw = makeGateway(tmp);
    assert.ok(gw._findExecutor('harness2.run:gated'));
    assert.equal(gw._findExecutor('harness2.other:x'), null);
  } finally { cleanup(tmp); }
});
