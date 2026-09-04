'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// W10 continuity tests: goals + policy-gated steps + approval integration,
// loops on an injected fake clock, slash dispatcher, corrupt-file fail-closed,
// and real HTTP smoke tests over the mounts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { GoalEngine, ContinuityStore } = require('../src/gateway/continuity');
const { ApprovalStore } = require('../src/gateway/approvals');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cont-${name}-`));
}

function makeBot(name, role, caps) {
  return { name, token: `tok-${name}`, role, capabilities: caps };
}

function makeGateway({ file, dispatch, now } = {}) {
  return new Gateway({
    bots: {
      forge: makeBot('forge', 'worker', ['fs.write:*', 'fs.read']),
      scout: makeBot('scout', 'worker', ['fs.read', 'web.get']),
      atlas: makeBot('atlas', 'operator', ['*']),
    },
    dispatch: dispatch || (async (_bot, tool, args) => ({ ok: true, tool, args })),
    approvals: new ApprovalStore({ now }),
    now,
  });
}

function buildServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return {
    server,
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// Use the engine the mounts actually resolve (WeakMap singleton keyed on gw),
// but point it at a per-test file so state is isolated.
function getEngineForTest(gw, file) {
  const { getEngine } = require('../src/gateway/continuity');
  const e = getEngine(gw);
  e.store.file = file;
  return e;
}

// ── store: durability + fail closed ────────────────────────────────

test('ContinuityStore: atomic save, 0600, survives reload', () => {
  const dir = tmpdir('store');
  const file = path.join(dir, 'continuity.json');
  const store = new ContinuityStore({ file });
  store.goals.set('goal_000001', {
    id: 'goal_000001', text: 'x', status: 'active', owner: 'forge',
    steps: [{ tool: 'fs.read', state: 'done', attempts: 1, lastDecision: 'allow', approvalId: null, args: null, updatedAt: 1 }],
    loop: null, createdAt: 1, updatedAt: 1,
  });
  store.save();
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'file must be 0600');
  const reloaded = new ContinuityStore({ file });
  assert.equal(reloaded.goals.size, 1);
  assert.equal(reloaded.goals.get('goal_000001').status, 'active');
  assert.equal(reloaded._next, 2, 'id counter resumes after reload');
});

test('ContinuityStore: corrupt file refuses to load (fail closed)', () => {
  const dir = tmpdir('corrupt');
  const file = path.join(dir, 'continuity.json');
  fs.writeFileSync(file, '{"version":1,"goals":[{"id":"goal_000001"'); // truncated
  assert.throws(() => new ContinuityStore({ file }), /refusing to load/);
  fs.writeFileSync(file, '{"goals": "not-an-array"}');
  assert.throws(() => new ContinuityStore({ file }), /must be/);
  fs.writeFileSync(file, '{"goals":[{"id":"g1","status":"bogus","steps":[]}]}');
  assert.throws(() => new ContinuityStore({ file }), /unknown status/);
  // And no file at all is fine (fresh store).
  const fresh = new ContinuityStore({ file: path.join(dir, 'missing.json') });
  assert.equal(fresh.goals.size, 0);
});

// ── engine: goals + steps + policy ─────────────────────────────────

function makeEngine(gw, { file } = {}) {
  return new GoalEngine({ gw, file, now: gw.now });
}

test('goal add projects args away and persists', async () => {
  const dir = tmpdir('add');
  const gw = makeGateway({ file: path.join(dir, 'c.json') });
  const engine = makeEngine(gw, { file: path.join(dir, 'c.json') });
  const g = engine.add({
    text: 'ship the report',
    owner: 'forge',
    steps: [{ tool: 'fs.write:report.md', args: { secret: 'do-not-leak' } }],
  });
  assert.equal(g.status, 'active');
  assert.equal(g.steps[0].state, 'pending');
  const p = engine.project(g);
  assert.ok(!('args' in p.steps[0]), 'projection must not carry args');
  assert.ok(!JSON.stringify(p).includes('do-not-leak'), 'no arg values in projection');
  // durable
  const reloaded = new ContinuityStore({ file: path.join(dir, 'c.json') });
  assert.equal(reloaded.goals.size, 1);
  assert.equal(reloaded.goals.get(g.id).steps[0].tool, 'fs.write:report.md');
  // audited
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_added' && e.goalId === g.id));
});

test('goal.step: read step auto-runs, write step parks approval for owner cap', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  // scout owns the goal: has fs.read but NOT fs.write → writes need approval.
  const g = engine.add({
    text: 'research then write',
    owner: 'scout',
    steps: [{ tool: 'fs.read' }, { tool: 'fs.write:x.md' }],
  });
  const out1 = await engine.takeStep(g.id);
  assert.equal(out1.verdict.decision, 'allow');
  assert.equal(g.steps[0].state, 'done');
  assert.ok(g.steps[0].attempts === 1);

  const out2 = await engine.takeStep(g.id);
  assert.equal(out2.verdict.decision, 'needs_approval');
  assert.equal(g.steps[1].state, 'awaiting_approval');
  assert.ok(out2.approvalId);
  // an approval request was parked through the real store
  const pending = gw.approvals.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, out2.approvalId);
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_step_awaiting_approval' && e.approvalId === out2.approvalId));
});

test('goal.step: destructive tool never auto-runs even with capability', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  const g = engine.add({ text: 'cleanup', owner: 'atlas', steps: [{ tool: 'shell.run', args: { cmd: 'rm -rf /tmp/x' } }] });
  const out = await engine.takeStep(g.id);
  assert.equal(out.verdict.decision, 'needs_approval', 'destructive always needs approval');
  assert.equal(g.steps[0].state, 'awaiting_approval');
});

test('goal.step: deny stops the step and is audited', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  const g = engine.add({ text: 'steal secrets', owner: 'forge', steps: [{ tool: 'secret.read:vault' }] });
  const out = await engine.takeStep(g.id);
  assert.equal(out.verdict.decision, 'deny');
  assert.equal(g.steps[0].state, 'denied');
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_step_denied'));
});

test('goal + step approval integration: operator approval completes the step (real flow)', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  // scout lacks fs.write → the step parks an approval request.
  const g = engine.add({ text: 'write report', owner: 'scout', steps: [{ tool: 'fs.write:r.md' }] });
  const out = await engine.takeStep(g.id);
  assert.equal(out.verdict.decision, 'needs_approval');
  const approvalId = out.approvalId;

  // Operator approves through the REAL server flow (executes parked action).
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(`${base}/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.result.tool, 'fs.write:r.md');
    assert.equal(body.result.ok, true);
  } finally {
    await ctx.close();
  }
  // The approval_resolved audit folded back into the step state.
  assert.equal(g.steps[0].state, 'done');
  assert.equal(g.steps[0].lastDecision, 'approved');
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_stepped' && e.decision === 'approved'));
  assert.ok(gw.chain.verify().ok, 'chain must still verify');
});

test('goal lifecycle: pause/resume/clear with RBAC guard', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  const g = engine.add({ text: 't', owner: 'forge', steps: [] });
  const workerBot = makeBot('rival', 'worker', []);
  assert.throws(() => engine.pause(g.id, workerBot), /may pause/);
  engine.pause(g.id, makeBot('forge', 'worker', ['fs.read']));
  assert.equal(g.status, 'paused');
  assert.throws(() => engine.resume(g.id, workerBot), /may resume/);
  engine.resume(g.id, makeBot('atlas', 'operator', ['*']));
  assert.equal(g.status, 'active');
  engine.clear(g.id, makeBot('forge', 'worker', ['fs.read']));
  assert.equal(g.status, 'cleared');
  assert.equal(engine.list().length, 0, 'cleared goals hidden by default');
  assert.equal(engine.list({ includeCleared: true }).length, 1);
});

test('goal completes when steps are exhausted', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  const g = engine.add({ text: 'one read', owner: 'forge', steps: [{ tool: 'fs.read' }] });
  await engine.takeStep(g.id);
  const out = await engine.takeStep(g.id);
  assert.equal(out.done, true);
  assert.equal(g.status, 'done');
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_completed'));
});

// ── loops with injected fake clock ─────────────────────────────────

class FakeClock {
  constructor() { this.nowMs = 1_000_000; this.timers = new Map(); this._next = 1; }
  now() { return this.nowMs; }
  setInterval(fn, ms) { const id = this._next++; this.timers.set(id, fn); return id; }
  clearInterval(id) { this.timers.delete(id); }
  // Advance and AWAIT each tick's promise, so overlapping-tick skips can't
  // make counts nondeterministic (real setInterval skips slow ticks; here we
  // test the fully-serialized behavior).
  async advance(ms) {
    this.nowMs += ms;
    for (const fn of [...this.timers.values()]) await fn();
  }
}

test('goal.loop fires on injected clock; stops on deny and at maxRuns', async () => {
  const clock = new FakeClock();
  const gw = makeGateway({ now: () => clock.now() });
  const engine = new GoalEngine({ gw, file: null, now: () => clock.now(), setIntervalFn: (f, ms) => clock.setInterval(f, ms), clearIntervalFn: (id) => clock.clearInterval(id) });

  const g1 = engine.add({ text: 'loop reads', owner: 'forge', steps: [{ tool: 'fs.read' }, { tool: 'fs.read' }, { tool: 'fs.read' }] });
  engine.startLoop(g1.id, { everyMs: 10, maxRuns: 100 }, makeBot('forge', 'worker', ['fs.read']));
  assert.ok(g1.loop && g1.loop.runs === 0);
  await clock.advance(10);
  assert.equal(g1.loop.runs, 1);
  assert.equal(g1.steps[0].state, 'done');
  await clock.advance(10);
  await clock.advance(10);
  assert.equal(g1.loop.runs, 3);
  assert.equal(g1.steps[2].state, 'done');
  await clock.advance(10); // no pending steps → goal done, loop stops
  assert.equal(g1.status, 'done');
  assert.equal(engine._loops.size, 0, 'loop timer cleared on completion');
  assert.equal(clock.timers.size, 0);

  // deny stops the loop immediately
  const g2 = engine.add({ text: 'loop hits a deny', owner: 'forge', steps: [{ tool: 'fs.read' }, { tool: 'secret.read:vault' }] });
  engine.startLoop(g2.id, { everyMs: 5, maxRuns: 10 }, makeBot('forge', 'worker', ['fs.read']));
  await clock.advance(5);
  await clock.advance(5); // second tick denies → stop
  assert.equal(g2.steps[1].state, 'denied');
  assert.equal(engine._loops.has(g2.id), false, 'loop must stop on deny');
  const entries = gw.chain.entries.map((e) => e.payload);
  assert.ok(entries.some((e) => e.type === 'goal_loop_stopped' && e.reason === 'denied'));

  // maxRuns stops
  const g3 = engine.add({ text: 'max runs', owner: 'forge', steps: [{ tool: 'fs.read' }, { tool: 'fs.read' }, { tool: 'fs.read' }, { tool: 'fs.read' }, { tool: 'fs.read' }] });
  engine.startLoop(g3.id, { everyMs: 5, maxRuns: 2 }, makeBot('forge', 'worker', ['fs.read']));
  await clock.advance(5);
  await clock.advance(5);
  assert.equal(g3.loop.runs, 2);
  await clock.advance(5); // third tick: maxRuns reached → stop
  assert.equal(engine._loops.has(g3.id), false);
});

test('loop timers are unref\u0027d (never hold the process open)', async () => {
  const gw = makeGateway();
  let captured = null;
  const orig = setInterval;
  const fakeSetInterval = (fn, ms) => { const t = orig(fn, ms); captured = t; return t; };
  const engine2 = new GoalEngine({ gw, setIntervalFn: fakeSetInterval });
  const g = engine2.add({ text: 'unref', owner: 'forge', steps: [{ tool: 'fs.read' }] });
  engine2.startLoop(g.id, { everyMs: 5, maxRuns: 1 }, makeBot('forge', 'worker', ['fs.read']));
  assert.ok(captured && typeof captured.unref === 'function');
  assert.ok(captured.hasRef && !captured.hasRef(), 'timer must be unref\u0027d');
  engine2.stopLoop(g.id, 'test');
});

// ── slash dispatcher ───────────────────────────────────────────────

test('slash dispatcher: /goal add|status|pause|resume|clear, /loop, /resume', async () => {
  const clock = new FakeClock();
  const gw = makeGateway({ now: () => clock.now() });
  const engine = new GoalEngine({ gw, file: null, now: () => clock.now(), setIntervalFn: (f, ms) => clock.setInterval(f, ms), clearIntervalFn: (id) => clock.clearInterval(id) });
  const forge = makeBot('forge', 'worker', ['fs.read']);

  const add = await engine.slash(forge, '/goal add write the docs');
  assert.ok(add.ok);
  const id = add.message.match(/goal (goal_\d+)/)[1];

  const status = await engine.slash(forge, '/goal status');
  assert.ok(status.goals.some((g) => g.id === id));

  const paused = await engine.slash(forge, `/goal pause ${id}`);
  assert.ok(paused.ok);
  const resumed = await engine.slash(forge, `/goal resume ${id}`);
  assert.ok(resumed.ok);

  // /resume replays the next pending step — goal has none, so it completes.
  const resumeAll = await engine.slash(forge, `/resume ${id}`);
  assert.equal(resumeAll.result.goalId, id);

  // /loop start + stop
  const g2 = engine.add({ text: 'looped', owner: 'forge', steps: [{ tool: 'fs.read' }] });
  const started = await engine.slash(forge, `/loop start ${g2.id} 5 3`);
  assert.ok(started.ok);
  assert.ok(g2.loop && g2.loop.everyMs === 5 && g2.loop.maxRuns === 3);
  await clock.advance(5);
  assert.equal(g2.loop.runs, 1);
  const stopped = await engine.slash(forge, `/loop stop ${g2.id}`);
  assert.ok(stopped.ok);
  assert.equal(engine._loops.has(g2.id), false);

  // cleared goals leave the default list
  await engine.slash(forge, `/goal clear ${id}`);
  const after = await engine.slash(forge, '/goal status');
  assert.ok(!after.goals.some((g) => g.id === id));

  // audited (both ok and failing runs) — capture AFTER the failing run below
  let entries = gw.chain.entries.map((e) => e.payload);
  const slashEntries = entries.filter((e) => e.type === 'slash_run');
  assert.ok(slashEntries.length >= 6);
  assert.ok(slashEntries.every((e) => typeof e.cmd === 'string' && typeof e.ok === 'boolean'));
  await assert.rejects(() => engine.slash(forge, '/goal nope'), /usage|unknown/);
  entries = gw.chain.entries.map((e) => e.payload);
  const failed = entries.filter((e) => e.type === 'slash_run' && e.ok === false);
  assert.ok(failed.length >= 1, 'failed slash runs are audited too');
});

test('slash: unknown bot-less / operator guardrails surface as errors', async () => {
  const gw = makeGateway();
  const engine = makeEngine(gw);
  const rival = makeBot('rival', 'worker', []);
  const g = engine.add({ text: 'x', owner: 'atlas', steps: [] });
  await assert.rejects(() => engine.slash(rival, `/goal pause ${g.id}`), /may pause/);
});

// ── HTTP mounts over real HTTP ─────────────────────────────────────

test('HTTP: GET/POST /v2/goals, step, resume, /v2/slash end-to-end', async () => {
  const dir = tmpdir('http');
  const gw = makeGateway();
  const engine = getEngineForTest(gw, path.join(dir, 'c.json'));
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const auth = { authorization: 'Bearer tok-forge' };
    // create with a step list
    let res = await fetch(`${base}/v2/goals`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'http goal', steps: [{ tool: 'fs.read' }, { tool: 'fs.write:out.md' }] }),
    });
    assert.equal(res.status, 201);
    const { goal } = await res.json();
    assert.equal(goal.owner, 'forge');
    assert.equal(goal.steps.length, 2);
    assert.ok(!('args' in goal.steps[0]));

    // list
    res = await fetch(`${base}/v2/goals`, { headers: auth });
    assert.equal(res.status, 200);
    const listed = (await res.json()).goals;
    assert.ok(listed.some((g) => g.id === goal.id));

    // step 1: allow
    res = await fetch(`${base}/v2/goals/${goal.id}/step`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.decision, 'allow');
    assert.equal(body.done, false);

    // step 2: needs approval (write without... forge HAS fs.write:* → allow via cap)
    // forge has fs.write:* so this is allow. Force an approval case with secret:
    res = await fetch(`${base}/v2/goals`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'secret goal', steps: [{ tool: 'secret.read:vault' }] }),
    });
    const { goal: g2 } = await res.json();
    res = await fetch(`${base}/v2/goals/${g2.id}/step`, { method: 'POST', headers: auth });
    body = await res.json();
    assert.equal(body.decision, 'deny');
    assert.equal(res.status, 200); // step executed, decision recorded on the step

    // slash over HTTP
    res = await fetch(`${base}/v2/slash`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: `/goal pause ${goal.id}` }),
    });
    assert.equal(res.status, 200);
    // resume endpoint (paused → active + one step)
    res = await fetch(`${base}/v2/goals/${goal.id}/resume`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.resumed, true);

    // unauthorized
    res = await fetch(`${base}/v2/goals`);
    assert.equal(res.status, 401);
    res = await fetch(`${base}/v2/slash`, { method: 'POST', headers: auth, body: 'not json' });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/v2/goals/nope/step`, { method: 'POST', headers: auth });
    assert.equal(res.status, 404);

    assert.ok(gw.chain.verify().ok);
    // durable across "restart"
    assert.equal(new ContinuityStore({ file: path.join(dir, 'c.json') }).goals.size >= 2, true);
  } finally {
    await ctx.close();
  }
});

test('HTTP: /v2/slash /goal add works and audits', async () => {
  const gw = makeGateway();
  const engine = getEngineForTest(gw, null);
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(`${base}/v2/slash`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-forge', 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: '/goal add write release notes' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);
    const goals = engine.list();
    assert.ok(goals.some((g) => g.text === 'write release notes'), '/goal add created the goal');
  } finally {
    await ctx.close();
  }
});