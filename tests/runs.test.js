'use strict';
// Wave F F1 — first-class Run/Step objects: persistence, lifecycle, HTTP
// surface, eviction, hygiene, and deepTurn integration. Local stubs only;
// every store writes to an isolated tmpdir file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { RunStore, getRuns, digestOf, MAX_RUNS } = require('../src/gateway/runs');
const { Gateway } = require('../src/gateway/server');
const { deepTurn } = require('../src/gateway/llm-loop');
const { getBrain, setBrain } = require('../src/gateway/llm-brain');

// ── helpers ─────────────────────────────────────────────────────────

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-runs-'));
}
function freshStore({ now = null, maxRuns = MAX_RUNS } = {}) {
  const dir = tmpdir();
  const store = new RunStore({
    file: path.join(dir, 'runs.json'),
    goalIndexFile: path.join(dir, 'run-by-goal.json'),
    maxRuns,
    ...(now ? { now } : {}),
  });
  return { store, dir };
}
function makeGw(store) {
  const calls = [];
  const gw = new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      rex: { token: 'tok-rex', role: 'worker', capabilities: ['fs.read'] },
    },
    dispatch: async (bot, tool) => {
      calls.push({ bot, tool });
      if (tool.startsWith('fs.read:')) return { path: tool.slice(8), content: 'hello' };
      throw new Error('should_not_reach:' + tool);
    },
  });
  if (store) {
    gw.runs = store; // getRuns() honors a pre-assigned store...
    store.gw = gw;   // ...and audits into this gateway's chain
  }
  return { gw, calls };
}
function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}
const get = (base, p, token = 'tok-forge') =>
  fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (base, p, token = 'tok-forge') =>
  fetch(`${base}${p}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });

function stubBrain(responses) {
  let n = 0;
  return {
    configured: true,
    sessions: new Map(),
    chat: async () => responses[Math.min(n++, responses.length - 1)],
  };
}

// ── unit: lifecycle + persistence ───────────────────────────────────

test('runs: runStart/runStep/runEnd round-trip persists and reloads', () => {
  const { store, dir } = freshStore();
  const run = store.runStart('llm-loop', { session: 'sess-1', bot: 'forge', goalId: 'g-42' });
  assert.match(run.id, /^r_[0-9a-f]{8}$/);
  assert.equal(run.state, 'running');
  assert.equal(run.engine, 'llm-loop');
  assert.deepEqual(run.artifacts, []);
  assert.deepEqual(run.steps, []);

  const step = store.runStep(run.id, {
    kind: 'action', tool: 'fs.read:notes/x.md',
    args: { p: 'ARG-PLAINTEXT-42' }, decision: 'allow',
    result: { out: 'RESULT-PLAINTEXT-42' },
  });
  assert.match(step.id, /^s_[0-9a-f]{8}$/);
  assert.equal(step.seq, 0);
  assert.equal(step.runId, run.id);
  assert.deepEqual(run.steps, [step.id]);
  store.runEnd(run.id, { exitCode: 0 });
  assert.equal(store.get(run.id).state, 'completed');

  // reload from disk into a fresh store — same run, same steps
  const s2 = new RunStore({
    file: path.join(dir, 'runs.json'),
    goalIndexFile: path.join(dir, 'run-by-goal.json'),
  });
  const loaded = s2.getById(run.id);
  assert.ok(loaded, 'run survives restart');
  assert.equal(loaded.state, 'completed');
  assert.equal(loaded.steps.length, 1);
  assert.equal(loaded.steps[0].id, step.id);
  assert.equal(loaded.steps[0].argsDigest, digestOf({ p: 'ARG-PLAINTEXT-42' }));
  assert.equal(loaded.steps[0].resultDigest, digestOf({ out: 'RESULT-PLAINTEXT-42' }));
});

test('runs: digests are sha256(plaintext)[:16]; no args/results plaintext anywhere on disk', () => {
  const { store, dir } = freshStore();
  const run = store.runStart('planner', { bot: 'forge' });
  store.runStep(run.id, {
    kind: 'action', tool: 'fs.read:x',
    args: { secret: 'SUPER-SECRET-VALUE' }, decision: 'allow',
    result: 'RESULT-TEXT-VALUE',
  });
  store.runEnd(run.id, {});
  const disk = fs.readFileSync(path.join(dir, 'runs.json'), 'utf8');
  assert.ok(!disk.includes('SUPER-SECRET-VALUE'), 'no arg plaintext on disk');
  assert.ok(!disk.includes('RESULT-TEXT-VALUE'), 'no result plaintext on disk');
  const doc = JSON.parse(disk);
  const storedRun = doc[run.id];
  assert.ok(!('args' in storedRun) && !('result' in storedRun), 'Run shape scan: no args/result keys');
  const step = doc.steps[run.steps[0]];
  assert.ok(!('args' in step) && !('result' in step), 'Step shape scan: no args/result keys');
  const sha = (v) => crypto.createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex').slice(0, 16);
  assert.equal(step.argsDigest, sha({ secret: 'SUPER-SECRET-VALUE' }));
  assert.equal(step.resultDigest, sha('RESULT-TEXT-VALUE'));
  // atomic write hygiene: 0600, no .tmp left behind (approvals.js pattern)
  assert.ok(!fs.existsSync(path.join(dir, 'runs.json.tmp')));
  assert.equal(fs.statSync(path.join(dir, 'runs.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'run-by-goal.json')).mode & 0o777, 0o600);
});

test('runs: concurrent runs keep independent steps; goal index persists', () => {
  const { store, dir } = freshStore();
  const a = store.runStart('llm-loop', { session: 'a', bot: 'forge', goalId: 'gA' });
  const b = store.runStart('planner', { session: 'b', bot: 'atlas', goalId: 'gB' });
  store.runStep(a.id, { kind: 'plan', result: 'a-plan' });
  store.runStep(b.id, { kind: 'action', tool: 'fs.read:x', decision: 'allow' });
  store.runStep(a.id, { kind: 'action', tool: 'fs.read:y', decision: 'allow' });
  store.runEnd(a.id, {});
  store.runEnd(b.id, { exitCode: 1 });
  assert.equal(store.getById(a.id).steps.length, 2);
  assert.equal(store.getById(b.id).steps.length, 1);
  assert.equal(store.getById(a.id).steps[1].seq, 1);
  assert.equal(store.getById(b.id).state, 'failed');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'run-by-goal.json'), 'utf8'));
  assert.deepEqual(idx.gA, [a.id]);
  assert.deepEqual(idx.gB, [b.id]);
  const s2 = new RunStore({ file: path.join(dir, 'runs.json'), goalIndexFile: path.join(dir, 'run-by-goal.json') });
  assert.deepEqual(s2.goalRuns('gA').map((r) => r.id), [a.id]);
  assert.deepEqual(s2.goalRuns('gB').map((r) => r.id), [b.id]);
});

test('runs: cancel lifecycle + run_started/run_completed/run_paused audit types', () => {
  const { store } = freshStore();
  const audited = [];
  store.gw = { _audit: (p) => audited.push(p) };
  const live = store.runStart('llm-loop', { bot: 'forge' });
  const done = store.runStart('planner', { bot: 'forge' });
  store.runEnd(done.id, {});
  assert.equal(store.cancel(live.id).state, 'canceled');
  assert.equal(store.cancel(live.id), null, 'already canceled → no double cancel');
  assert.equal(store.cancel(done.id), null, 'terminal run is not cancellable');
  const paused = store.runStart('harness', { bot: 'forge' });
  store.runEnd(paused.id, { state: 'paused' });
  assert.equal(store.get(paused.id).state, 'paused');

  const types = audited.map((a) => a.type);
  assert.ok(types.includes('run_started'));
  assert.ok(types.includes('run_completed'));
  assert.ok(types.includes('run_paused'));
  assert.equal(audited.filter((a) => a.type === 'run_paused').length, 2, 'cancel + paused both emit run_paused');
  assert.ok(audited.every((a) => a.runId && typeof a.runId === 'string'));
  assert.ok(audited.every((a) => !('args' in a) && !('result' in a)), 'run audits carry metadata only');

  const bad = store.runStart('llm-loop', { bot: 'forge' });
  store.runEnd(bad.id, { exitCode: 1 });
  assert.equal(store.get(bad.id).state, 'failed');
  assert.ok(store.get(bad.id).endedAt !== null);
  assert.equal(store.runEnd(bad.id, {}).state, 'failed', 'terminal run is not re-ended');
});

test('runs: FIFO eviction caps the store (maxRuns option and default 200)', () => {
  const { store } = freshStore({ maxRuns: 5 });
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const r = store.runStart('harness', { bot: `b${i}` });
    store.runStep(r.id, { kind: 'action', tool: 'harness.run:app', decision: 'allow' });
    store.runEnd(r.id, { exitCode: 0 });
    ids.push(r.id);
  }
  assert.equal(store.runs.size, 5);
  assert.ok(ids.slice(0, 2).every((id) => !store.get(id)), 'oldest two evicted FIFO');
  assert.ok(ids.slice(2).every((id) => store.get(id)), 'newest kept');
  assert.equal(store.steps.size, 5, 'evicted steps pruned with their run');

  const { store: big } = freshStore();
  for (let i = 0; i < MAX_RUNS + 3; i++) big.runEnd(big.runStart('harness', { bot: 'x' }).id, {});
  assert.equal(big.runs.size, MAX_RUNS, 'default cap 200');
});

test('runs: corrupt file refuses to load (fail closed); bad engine/kind rejected', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'runs.json');
  fs.writeFileSync(f, '{broken');
  assert.throws(() => new RunStore({ file: f }), /refusing to load/);

  const { store } = freshStore();
  assert.throws(() => store.runStart('nonsense', {}), /bad_engine|unknown engine/);
  const r = store.runStart('harness', {});
  assert.throws(() => store.runStep(r.id, { kind: 'bogus' }), /bad_kind|unknown step kind/);
  assert.equal(store.runStep('r_deadbeef', { kind: 'plan' }), null, 'unknown run tolerated');
  assert.equal(store.runEnd('r_deadbeef', {}), null);
  assert.equal(store.cancel('r_nosuch'), null);
});

test('runs: getRuns(gw) is a per-gateway singleton honoring a pre-assigned gw.runs', () => {
  const bare = makeGw(null).gw;
  const { store } = freshStore();
  const wired = makeGw(store).gw;
  assert.strictEqual(getRuns(wired), store, 'pre-assigned gw.runs wins');
  const first = getRuns(bare);
  assert.ok(first instanceof RunStore);
  assert.strictEqual(getRuns(bare), first, 'WeakMap singleton per gateway');
  assert.strictEqual(bare.runs, first, 'exposed back as gw.runs for harness authors');
});

// ── HTTP surface: mounts/96-runs.js ─────────────────────────────────

test('HTTP /v2/runs: default last 50 + bot/state/goalId filters + bearer auth', async () => {
  const { store } = freshStore();
  for (let i = 0; i < 55; i++) {
    const r = store.runStart('llm-loop', { bot: i % 2 ? 'forge' : 'atlas', goalId: i < 3 ? 'g-x' : null });
    store.runEnd(r.id, {});
  }
  const { gw } = makeGw(store);
  const front = await startGateway(gw);
  try {
    const res = await get(front.base, '/v2/runs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 50, 'default last 50');

    const fb = await (await get(front.base, '/v2/runs?bot=forge')).json();
    assert.ok(fb.count > 0 && fb.runs.every((r) => r.bot === 'forge'));

    const gb = await (await get(front.base, '/v2/runs?goalId=g-x')).json();
    assert.ok(gb.count >= 1 && gb.count <= 3 && gb.runs.every((r) => r.goalId === 'g-x'));

    const sb = await (await get(front.base, '/v2/runs?state=completed')).json();
    assert.ok(sb.runs.every((r) => r.state === 'completed'));

    assert.equal((await get(front.base, '/v2/runs', null)).status, 401, 'bearer required');
  } finally { await front.close(); }
});

test('HTTP /v2/runs/:id: run + steps + chain refs for provenance', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  const run = store.runStart('llm-loop', { session: 's', bot: 'forge' });
  store.runStep(run.id, { kind: 'action', tool: 'fs.read:n.md', args: { a: 1 }, decision: 'allow', result: { ok: true } });
  store.runEnd(run.id, { exitCode: 0 });
  const front = await startGateway(gw);
  try {
    const res = await get(front.base, `/v2/runs/${run.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run.id, run.id);
    assert.equal(body.run.steps.length, 1);
    assert.equal(body.run.steps[0].tool, 'fs.read:n.md');
    assert.ok(body.run.steps[0].argsDigest);
    const refTypes = body.chainRefs.map((r) => r.type);
    assert.ok(refTypes.includes('run_started') && refTypes.includes('run_completed'), 'provenance refs include run_* entries');
    assert.ok(body.chainRefs.every((r) => typeof r.seq === 'number' && typeof r.hash === 'string' && r.type));

    assert.equal((await get(front.base, '/v2/runs/r_00000000')).status, 404);
    assert.equal((await get(front.base, '/v2/runs/not-a-run-id')).status, 400);
    assert.equal((await get(front.base, '/v2/runs')).status, 200);
  } finally { await front.close(); }
});

test('HTTP /v2/runs/:id/cancel: operator + run owner allowed, others 403', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  const a = store.runStart('llm-loop', { bot: 'forge' }); // owner cancels
  const b = store.runStart('llm-loop', { bot: 'rex' });   // operator cancels
  const c = store.runStart('llm-loop', { bot: 'atlas' }); // terminal → 409
  store.runEnd(c.id, {});

  const front = await startGateway(gw);
  try {
    const r1 = await post(front.base, `/v2/runs/${a.id}/cancel`, 'tok-forge');
    assert.equal(r1.status, 200, 'run owner may cancel');
    assert.equal((await r1.json()).state, 'canceled');
    assert.equal(store.get(a.id).state, 'canceled');

    const r2 = await post(front.base, `/v2/runs/${b.id}/cancel`, 'tok-atlas');
    assert.equal(r2.status, 200, 'operator may cancel any run');

    const d = store.runStart('llm-loop', { bot: 'forge' });
    const r3 = await post(front.base, `/v2/runs/${d.id}/cancel`, 'tok-rex');
    assert.equal(r3.status, 403, 'unrelated worker denied');
    assert.equal(store.get(d.id).state, 'running');

    const r4 = await post(front.base, `/v2/runs/${c.id}/cancel`, 'tok-atlas');
    assert.equal(r4.status, 409, 'terminal run not cancellable');

    const r5 = await post(front.base, '/v2/runs/r_ffffffff/cancel', 'tok-atlas');
    assert.equal(r5.status, 404);

    const paused = gw.chain.entries.filter((e) => e.payload.type === 'run_paused');
    assert.equal(paused.length, 2, 'both successful cancels audited run_paused');
    assert.deepEqual(paused.map((e) => e.payload.runId).sort(), [a.id, b.id].sort());
    assert.equal(gw.chain.verify().ok, true, 'chain still verifies');
  } finally { await front.close(); }
});

// ── integration: deepTurn wires Runs; return shape unchanged ────────

test('deepTurn materializes a run: one step per iteration, completed end, shape unchanged', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  setBrain(gw, stubBrain([
    'Reading now.\n<action tool="fs.read:notes/x.md" />',
    'All done.',
  ]));
  const out = await deepTurn(gw, getBrain(gw), { session: 'r1', message: 'read note' });
  // CRITICAL: the documented return shape is unchanged
  assert.deepEqual(Object.keys(out).sort(), ['actions', 'iterations', 'observationsTrusted', 'reply']);
  assert.equal(out.iterations, 2);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].decision, 'allow');

  const runs = store.list({}, 10);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.engine, 'llm-loop');
  assert.equal(run.bot, 'forge');
  assert.equal(run.session, 'r1');
  assert.equal(run.state, 'completed');
  assert.equal(run.steps.length, 2, 'one step per loop turn');
  assert.equal(run.steps[0].kind, 'action');
  assert.equal(run.steps[0].tool, 'fs.read:notes/x.md');
  assert.equal(run.steps[0].decision, 'allow');
  assert.ok(run.steps[0].resultDigest);
  assert.equal(run.steps[1].kind, 'plan');

  const types = gw.chain.entries.map((e) => e.payload.type);
  assert.ok(types.includes('run_started') && types.includes('run_completed'));
  assert.equal(gw.chain.verify().ok, true, 'chain verify still passes');
});

test('deepTurn with parked approval → run paused + run_paused in chain', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  setBrain(gw, stubBrain(['Wiping now.\n<action tool="shell.run" />']));
  const out = await deepTurn(gw, getBrain(gw), { session: 'r2', message: 'wipe' });
  assert.equal(out.pending_approval.tool, 'shell.run');
  const runs = store.list({}, 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'paused');
  assert.equal(runs[0].steps[0].decision, 'needs_approval');
  assert.ok(runs[0].steps[0].approvalId);
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'run_paused' && e.payload.runId === runs[0].id));
  assert.equal(gw.chain.verify().ok, true);
});

test('deepTurn fallback (configured=false) makes NO run and NO chain decision', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  setBrain(gw, { configured: false, sessions: new Map(), chat: async () => 'never' });
  const out = await deepTurn(gw, getBrain(gw), { session: 'f', message: 'hi' });
  assert.equal(out.fallback, true);
  assert.equal(store.runs.size, 0, 'no run for fallback turns');
  assert.ok(gw.chain.entries.every((e) => e.payload.type === 'genesis'), 'fallback makes no chain decisions');
});

test('denied proposal records a deny step and the run still completes', async () => {
  const { store } = freshStore();
  const { gw } = makeGw(store);
  setBrain(gw, stubBrain(['Try it.\n<action tool="secret.read:vault" />']));
  const out = await deepTurn(gw, getBrain(gw), { session: 'r3', message: 'read vault' });
  assert.equal(out.actions[0].decision, 'deny');
  const run = store.list({}, 10)[0];
  assert.equal(run.state, 'completed');
  assert.equal(run.steps[0].decision, 'deny');
  assert.ok(run.steps[0].argsDigest, 'deny step still digests the proposed args');
});