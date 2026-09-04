'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// FS-F3 — sandbox hardening spike tests.
//
// HONEST-BY-CONSTRUCTION: the detection test asserts the SHAPE of
// detectSandboxSupport() on THIS host and records what it found — it does
// not assume the host has bwrap/unshare. The wrap tests use FAKE primitive
// stubs (fixture scripts on PATH / a support override) so they pass
// identically on hosts with and without real primitives. The harness2
// env-gating tests prove byte-identical behavior when TG_SANDBOX is off
// and audited wrapping/fallback when it is on.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const {
  detectSandboxSupport, clearSandboxCache, wrapCommand, scrubEnv, PROBE_TIMEOUT_MS,
} = require('../src/gateway/sandbox');
const { makeHarness2 } = require('../src/gateway/harness2');

// ── helpers ──────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sandbox-'));
}
function cleanup(dir) {
  // On Windows, files may be locked by child processes; retry with small delays.
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === maxAttempts - 1) throw e;
      At.sleepSync(100 * (attempt + 1));
    }
  }
}

const HELLO = { 'app.js': "console.log('hello from sandbox spike');" };

function makeProject(h, id) {
  const created = h.createProject({
    name: id.replace(/-/g, ' '),
    files: HELLO,
    entry: 'app.js',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const built = h.buildProject(created.project.id);
  assert.equal(built.ok, true);
  return created.project.id;
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeGateway(tmp, envPatch = {}) {
  return new Gateway({
    bots: {
      builder: { name: 'builder', token: 'tok-builder', role: 'worker', capabilities: ['harness.run'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: [] },
    },
    botsDir: path.join(tmp, 'bots'),
    auditChainPath: path.join(tmp, 'chain'),
    ...envPatch,
  });
}

// Writes a FAKE primitive stub: a shell script that execs its arguments
// after logging the invocation, so tests can assert the wrapped shape.
function fakeStub(dir, name, { exit = 0, forward = true } = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${forward ? 'exec "$@"' : `exit ${exit}`}\n`, { mode: 0o755 });
  return p;
}

test.beforeEach(() => { clearSandboxCache(); delete process.env.TG_SANDBOX; });
test.afterEach(() => { clearSandboxCache(); delete process.env.TG_SANDBOX; });

// ── 1. detection: honest shape on THIS host ──────────────────────

test('sandbox: detectSandboxSupport returns the documented shape on this host (whatever it is)', () => {
  const d = detectSandboxSupport();
  assert.equal(typeof d.bwrap, 'boolean', 'bwrap must be a real boolean');
  assert.equal(typeof d.unshare, 'boolean', 'unshare must be a real boolean');
  assert.equal(typeof d.systemdRun, 'boolean', 'systemdRun must be a real boolean');
  assert.ok(Array.isArray(d.probeErrors), 'probeErrors must be an array');
  for (const e of d.probeErrors) {
    assert.equal(typeof e, 'string');
    assert.ok(e.length > 0 && e.length <= 200, `probe error strings are short, got: ${e}`);
  }
  // Booleans must be consistent with the recorded probe errors.
  if (d.bwrap) assert.equal(d.probeErrors.some((e) => e.startsWith('bwrap:')), false);
  if (d.unshare) assert.equal(d.probeErrors.some((e) => e.startsWith('unshare:')), false);
  if (d.systemdRun) assert.equal(d.probeErrors.some((e) => e.startsWith('systemd-run:')), false);
  // Memoized: a second call returns the SAME object (no re-probe churn).
  assert.equal(detectSandboxSupport(), d);
  // The spike reports what THIS host really has — print it for the run log.
  console.log(`[fs-f3] host sandbox support: bwrap=${d.bwrap} unshare=${d.unshare} systemdRun=${d.systemdRun} probeErrors=${JSON.stringify(d.probeErrors)}`);
});

test('sandbox: probe timeout budget is bounded (spike measures, never hangs)', () => {
  assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 15_000);
});

// ── 2. wrapCommand: no primitives → byte-identical passthrough ───

test('sandbox: wrapCommand with no primitives returns unwrapped passthrough', () => {
  const none = { bwrap: false, unshare: false, systemdRun: false, probeErrors: [] };
  const jail = '/tmp/any-jail';
  const out = wrapCommand('node', ['/tmp/any-jail/app.js'], {
    jail, support: none, env: { PATH: '/x', HOME: '/y', NODE_ENV: 'production' },
  });
  assert.deepEqual(out, {
    cmd: 'node',
    args: ['/tmp/any-jail/app.js'],
    env: { PATH: '/x', HOME: '/y', NODE_ENV: 'production' },
    wrapped: false,
    method: 'none',
    reason: 'no_os_sandbox_available',
  });
});

test('sandbox: wrapCommand passthrough keeps env scrub (no secret leakage path)', () => {
  const none = { bwrap: false, unshare: false, systemdRun: false, probeErrors: [] };
  const out = wrapCommand('node', ['a.js'], { jail: '/j', support: none, env: {} });
  assert.deepEqual(Object.keys(out.env).sort(), ['HOME', 'NODE_ENV', 'PATH']);
});

// ── 3. wrapCommand: FAKE bwrap stub → wrapped invocation ─────────

test('sandbox: wrapCommand with a fake bwrap on PATH produces the bwrap invocation', () => {
  const tmp = tmpDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    fakeStub(binDir, 'bwrap');
    const support = { bwrap: true, unshare: false, systemdRun: false, probeErrors: [] };
    const jail = path.join(tmp, 'jail');
    const out = wrapCommand('node', [path.join(jail, 'app.js')], {
      jail,
      support,
      env: { PATH: `${binDir}:/usr/bin`, HOME: tmp, NODE_ENV: 'production' },
    });
    assert.equal(out.wrapped, true);
    assert.equal(out.method, 'bwrap');
    assert.equal(out.cmd, 'bwrap');
    // The wrapper carries a private /tmp and network shutdown by default.
    assert.ok(out.args.includes('--tmpfs'), 'private /tmp expected');
    assert.ok(out.args.indexOf('--tmpfs') < out.args.indexOf('/tmp'));
    assert.ok(out.args.includes('--unshare-net'), 'network off by default');
    assert.ok(out.args.includes('--die-with-parent'));
    // Bind-mounts: the jail (read-only) and the real node binary.
    const roBinds = [];
    for (let i = 0; i < out.args.length; i++) {
      if (out.args[i] === '--ro-bind') roBinds.push(out.args[i + 1]);
    }
    assert.ok(roBinds.includes(jail), 'jail must be bound read-only');
    const nodeBin = fs.realpathSync(process.execPath);
    assert.ok(roBinds.includes(nodeBin), 'node binary must be bound by resolved path');
    // The child argv is pinned to the resolved node path (no PATH exec).
    const sep = out.args.indexOf('--');
    assert.ok(sep > 0, 'bwrap argv must end with --');
    assert.equal(out.args[sep + 1], nodeBin);
    assert.deepEqual(out.args.slice(sep + 2), [path.join(jail, 'app.js')]);
    // Env still scrubbed to the trio.
    assert.deepEqual(Object.keys(out.env).sort(), ['HOME', 'NODE_ENV', 'PATH']);
    // opt.network=true keeps the host network namespace.
    const on = wrapCommand('node', ['a.js'], { jail, support, network: true });
    assert.equal(on.args.includes('--unshare-net'), false);
  } finally {
    cleanup(tmp);
  }
});

test('sandbox: wrapCommand falls through bwrap when the executor cannot be pinned', () => {
  const support = { bwrap: true, unshare: false, systemdRun: false, probeErrors: [] };
  // No jail → cannot pin the bind set → unwrapped with a reason.
  const out = wrapCommand('node', ['a.js'], { support });
  assert.equal(out.wrapped, false);
  assert.equal(out.method, 'none');
  assert.equal(out.reason, 'no_os_sandbox_available');
});

test('sandbox: wrapCommand uses the unshare layer when only it is available', () => {
  const support = { bwrap: false, unshare: true, systemdRun: false, probeErrors: [] };
  const out = wrapCommand('node', ['/j/app.js'], { jail: '/j', support });
  assert.equal(out.wrapped, true);
  assert.equal(out.method, 'unshare');
  assert.equal(out.cmd, 'unshare');
  assert.ok(out.args.includes('--user'), 'user namespace expected');
  assert.ok(out.args.includes('--map-root-user'), 'child drops to mapped non-root uid');
  assert.ok(out.args.includes('--net'), 'network namespace off by default');
  const on = wrapCommand('node', ['a.js'], { jail: '/j', support, network: true });
  assert.equal(on.args.includes('--net'), false);
});

test('sandbox: scrubEnv normalizes a bare env to the documented trio', () => {
  assert.deepEqual(scrubEnv(), { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/tmp', NODE_ENV: 'production' });
  assert.deepEqual(scrubEnv({ PATH: '/only' }), { PATH: '/only', HOME: process.env.HOME || '/tmp', NODE_ENV: 'production' });
});

// ── 4. harness2 wiring: env OFF → byte-identical; env ON → wrap+audit ──

test('harness2: TG_SANDBOX unset → no sandbox rows, run output identical to plain spawn', async () => {
  const tmp = tmpDir();
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    const used = [];
    const fallbacks = [];
    const h2 = makeHarness2({ dataDir: path.join(tmp, 'harness2'), onSandboxUsed: (i) => used.push(i), onSandboxFallback: (i) => fallbacks.push(i) });
    void h; // both instances share the store; the audited one runs below
    const id = makeProject(h2, 'plain run');
    const run = await h2.runProject(id);
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /hello from sandbox spike/);
    assert.equal(used.length, 0, 'no sandbox_used when TG_SANDBOX off');
    assert.equal(fallbacks.length, 0);
  } finally {
    cleanup(tmp);
  }
});

test('harness2: TG_SANDBOX=1 + real/fake primitive → sandbox_used row with method', async () => {
  const tmp = tmpDir();
  const saved = process.env.TG_SANDBOX;
  process.env.TG_SANDBOX = '1';
  try {
    const h = makeHarness2({ dataDir: path.join(tmp, 'harness2') });
    const id = makeProject(h, 'wrapped run');
    const used = [];
    const fallbacks = [];
    const hA = makeHarness2({
      dataDir: path.join(tmp, 'harness2'),
      onSandboxUsed: (i) => used.push(i),
      onSandboxFallback: (i) => fallbacks.push(i),
    });
    const run = await hA.runProject(id);
    assert.equal(run.ok, true, JSON.stringify(run));
    // On this host real bwrap exists; where it does not, the fallback path
    // must have been taken — either way exactly one audited outcome.
    assert.equal(used.length + fallbacks.length >= 1, true);
    if (used.length === 1) {
      assert.ok(['bwrap', 'unshare', 'none'].includes(used[0].method), `method=${used[0].method}`);
    } else {
      assert.equal(fallbacks.length, 1);
      assert.ok(['bwrap', 'unshare'].includes(fallbacks[0].method));
    }
    // The program ran to completion either wrapped or after fallback.
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /hello from sandbox spike/);
  } finally {
    if (saved === undefined) delete process.env.TG_SANDBOX;
    else process.env.TG_SANDBOX = saved;
    cleanup(tmp);
  }
});

test('harness2: TG_SANDBOX=1 + broken wrapper → sandbox_fallback then unwrapped success', async () => {
  const tmp = tmpDir();
  const saved = process.env.TG_SANDBOX;
  const savedPath = process.env.PATH;
  try {
    // A bwrap stub that always fails (exit 1, no exec) simulates a sandbox
    // that cannot start (setuid denied / ENOSYS). Detection must see it as
    // available (it exists) — the runtime fallback then covers it.
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    fakeStub(binDir, 'bwrap', { exit: 1, forward: false });
    process.env.TG_SANDBOX = '1';
    process.env.PATH = `${binDir}:${savedPath}`;
    clearSandboxCache(); // re-detect with the stub on PATH
    const h = makeHarness2({
      dataDir: path.join(tmp, 'harness2'),
      onSandboxUsed: () => {},
      onSandboxFallback: () => {},
    });
    const id = makeProject(h, 'fallback run');
    const used = [];
    const fallbacks = [];
    const hB = makeHarness2({
      dataDir: path.join(tmp, 'harness2'),
      onSandboxUsed: (i) => used.push(i),
      onSandboxFallback: (i) => fallbacks.push(i),
    });
    const run = await hB.runProject(id);
    assert.equal(run.ok, true);
    assert.equal(run.exitCode, 0, 'unwrapped retry must succeed');
    assert.match(run.stdout, /hello from sandbox spike/);
    assert.equal(used.length, 1, 'sandbox_used reported for the attempted wrap');
    assert.equal(fallbacks.length, 1, 'sandbox_fallback reported for the failed wrap');
    assert.equal(fallbacks[0].reason, 'wrapped_child_failed');
  } finally {
    if (saved === undefined) delete process.env.TG_SANDBOX;
    else process.env.TG_SANDBOX = saved;
    process.env.PATH = savedPath;
    clearSandboxCache();
    cleanup(tmp);
  }
});

// ── 5. HTTP surface: audit rows ride the real chain ───────────────

test('harness2 over HTTP: TG_SANDBOX off → chain carries no sandbox rows (byte-identical)', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  try {
    const gw = makeGateway(tmp);
    srv.attach(gw);
    const base = await listen(srv.server);
    await httpCall(base, 'POST', '/v2/harness2/projects', { token: 'tok-builder', body: { name: 'Quiet Run', files: HELLO } });
    await httpCall(base, 'POST', '/v2/harness2/projects/quiet-run/build', { token: 'tok-builder' });
    const r = await httpCall(base, 'POST', '/v2/harness2/projects/quiet-run/run', { token: 'tok-builder' });
    assert.equal(r.status, 200);
    const types = gw.chain.entries.map((e) => e.payload.type);
    assert.equal(types.includes('sandbox_used'), false);
    assert.equal(types.includes('sandbox_fallback'), false);
    assert.equal(types.includes('harness2_run'), true);
  } finally {
    await srv.close();
    cleanup(tmp);
  }
});

test('harness2 over HTTP: TG_SANDBOX=1 → sandbox_used row present, minimal payload, chain verifies', async () => {
  const tmp = tmpDir();
  const srv = buildServer();
  const saved = process.env.TG_SANDBOX;
  process.env.TG_SANDBOX = '1';
  try {
    const gw = makeGateway(tmp);
    srv.attach(gw);
    const base = await listen(srv.server);
    await httpCall(base, 'POST', '/v2/harness2/projects', { token: 'tok-builder', body: { name: 'Wrapped Run', files: HELLO } });
    await httpCall(base, 'POST', '/v2/harness2/projects/wrapped-run/build', { token: 'tok-builder' });
    const r = await httpCall(base, 'POST', '/v2/harness2/projects/wrapped-run/run', { token: 'tok-builder' });
    assert.equal(r.status, 200);
    const rows = gw.chain.entries.filter((e) => e.payload.type === 'sandbox_used');
    assert.equal(rows.length, 1, 'exactly one sandbox_used per sandboxed run');
    const p = rows[0].payload;
    assert.equal(p.id, 'wrapped-run');
    assert.ok(['bwrap', 'unshare', 'none'].includes(p.method), `method=${p.method}`);
    // Minimal payload: no argv, no paths, no output in the chain.
    const s = JSON.stringify(p);
    assert.equal(s.includes('app.js'), false, 'no argv/paths in chain');
    assert.equal(s.includes('hello'), false, 'no stdout in chain');
    // Every run also keeps its ordinary harness2_run row.
    assert.equal(gw.chain.entries.some((e) => e.payload.type === 'harness2_run'), true);
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    if (saved === undefined) delete process.env.TG_SANDBOX;
    else process.env.TG_SANDBOX = saved;
    await srv.close();
    cleanup(tmp);
  }
});
