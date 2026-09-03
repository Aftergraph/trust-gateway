'use strict';
// FS-C1 — skills as first-class governed objects.
//
// Covers: CRUD + RBAC (operator or 'skill.author' cap), validation
// (slug/semver/policy-classified tools), shell-metachar rejection in
// templates AND run-time placeholder values, ?dry=1 planning, governed
// execution (read → allow + dispatch; destructive → parks as approval,
// never dispatched), and chain hygiene (no raw args anywhere in the
// audit chain).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { SkillStore, resolveTemplate, validateTemplate, METACHAR_RE } = require('../src/gateway/skills');
const { classify, decide, isClassified } = require('../src/gateway/policy');

// ── HTTP harness (mirrors v2-mounts.test.js) ─────────────────────

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

// dispatch mock that records every call — proof that destructive steps
// NEVER reach direct execution.
function makeGateway({ dispatchCalls = [], dispatchImpl = null, skillsFile = null } = {}) {
  const dispatch = dispatchImpl || (async (botName, tool, args) => {
    dispatchCalls.push({ bot: botName, tool, args });
    return { ok: true, tool };
  });
  const gw = new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      sky: { name: 'sky', token: 'tok-sky', role: 'worker', capabilities: ['fs.read', 'skill.author'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch,
  });
  if (skillsFile) gw._skillsFile = skillsFile;
  return gw;
}

async function api(url, method, path, token, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// HTTP tests get a per-test isolated skills file so runs never pollute
// the repo's data/skills.json (and never collide on unique names).
let tmpCounter = 0;
function isolatedGW(opts = {}) {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mount-'));
  const gw = makeGateway({ skillsFile: path.join(dir, `skills-${process.pid}-${++tmpCounter}.json`), ...opts });
  gw.__dir = dir;
  return gw;
}

const GOOD_SKILL = {
  name: 'read-release-notes',
  version: '1.0.0',
  description: 'read a notes file from the jail',
  steps: [{ tool: 'fs.read:notes.md', argsTemplate: '', approvalHint: 'none' }],
};

// ── RBAC ─────────────────────────────────────────────────────────

test('skills RBAC: worker without skill.author gets 403 on every route', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const list = await api(url, 'GET', '/v2/skills', 'tok-forge');
    assert.equal(list.status, 403);
    const create = await api(url, 'POST', '/v2/skills', 'tok-forge', GOOD_SKILL);
    assert.equal(create.status, 403);
    const patch = await api(url, 'PATCH', '/v2/skills/sk_12345678', 'tok-forge', { version: '2.0.0' });
    assert.equal(patch.status, 403);
    const del = await api(url, 'DELETE', '/v2/skills/sk_12345678', 'tok-forge');
    assert.equal(del.status, 403);
    const run = await api(url, 'POST', '/v2/skills/sk_12345678/run', 'tok-forge', { args: {} });
    assert.equal(run.status, 403);
  } finally { await ctx.close(); }
});

test('skills RBAC: operator role and skill.author cap are both allowed', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const op = await api(url, 'POST', '/v2/skills', 'tok-atlas', GOOD_SKILL);
    assert.equal(op.status, 201);
    const cap = await api(url, 'POST', '/v2/skills', 'tok-sky', { ...GOOD_SKILL, name: 'read-via-cap' });
    assert.equal(cap.status, 201);
  } finally { await ctx.close(); }
});

// ── CRUD ─────────────────────────────────────────────────────────

test('skills CRUD: create → list → get → patch → delete lifecycle', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const created = await api(url, 'POST', '/v2/skills', 'tok-atlas', GOOD_SKILL);
    assert.equal(created.status, 201);
    assert.ok(/^sk_[0-9a-f]{8}$/.test(created.body.id), 'id is sk_<8hex>');
    assert.equal(created.body.name, 'read-release-notes');
    assert.equal(created.body.createdBy, 'atlas');
    assert.equal(created.body.steps[0].tool, 'fs.read:notes.md');
    assert.equal(created.body.steps[0].argsTemplate, '');

    const list = await api(url, 'GET', '/v2/skills', 'tok-atlas');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 1);

    const one = await api(url, 'GET', `/v2/skills/${created.body.id}`, 'tok-atlas');
    assert.equal(one.status, 200);
    assert.equal(one.body.id, created.body.id);

    const patched = await api(url, 'PATCH', `/v2/skills/${created.body.id}`, 'tok-atlas', { version: '1.1.0' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.version, '1.1.0');
    assert.equal(patched.body.createdBy, 'atlas', 'createdBy is immutable');

    const gone = await api(url, 'DELETE', `/v2/skills/${created.body.id}`, 'tok-atlas');
    assert.equal(gone.status, 200);
    assert.equal((await api(url, 'GET', `/v2/skills/${created.body.id}`, 'tok-atlas')).status, 404);

    // duplicate name → 409
    await api(url, 'POST', '/v2/skills', 'tok-atlas', GOOD_SKILL);
    const dup = await api(url, 'POST', '/v2/skills', 'tok-atlas', GOOD_SKILL);
    assert.equal(dup.status, 409);
  } finally { await ctx.close(); }
});

test('skills persistence: store round-trips through skills.json (0600, atomic)', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  const file = path.join(dir, 'skills.json');
  const store = new SkillStore({ file, now: () => 1759000000000 });
  const skill = store.create({ ...GOOD_SKILL, createdBy: 'atlas' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file mode is 0600');
  const reloaded = new SkillStore({ file, now: () => 1759000001000 });
  assert.equal(reloaded.get(skill.id).name, 'read-release-notes');
  assert.equal(reloaded.get(skill.id).createdAt, 1759000000000);
  // corrupt file → refuse to load (fail closed)
  fs.writeFileSync(file, '{corrupt', 'utf8');
  assert.throws(() => new SkillStore({ file }), /refusing to load/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── validation ───────────────────────────────────────────────────

test('skills validation: slug / semver / steps shape are enforced', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const cases = [
      ['bad slug', { ...GOOD_SKILL, name: 'Not a Slug' }],
      ['short slug', { ...GOOD_SKILL, name: 'ab' }],
      ['bad semver', { ...GOOD_SKILL, version: '1.0' }],
      ['no steps', { ...GOOD_SKILL, steps: [] }],
      ['step without tool', { ...GOOD_SKILL, steps: [{ argsTemplate: '' }] }],
      ['argsTemplate not a string', { ...GOOD_SKILL, steps: [{ tool: 'fs.read:notes.md', argsTemplate: 5 }] }],
    ];
    for (const [label, body] of cases) {
      const r = await api(url, 'POST', '/v2/skills', 'tok-atlas', body);
      assert.equal(r.status, 400, `expected 400 for ${label}`);
    }
  } finally { await ctx.close(); }
});

test('skills validation: step tools MUST classify in policy (unknown → 400)', async () => {
  assert.equal(isClassified('fs.read:notes.md'), true);
  assert.equal(isClassified('shell.run'), true);
  assert.equal(isClassified('totally.made.up:tool'), false, 'unknown tool is NOT classified');
  assert.equal(classify('totally.made.up:tool'), 'destructive', 'classify still fails closed');

  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const r = await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      ...GOOD_SKILL,
      steps: [{ tool: 'totally.made.up:tool', argsTemplate: '' }],
    });
    assert.equal(r.status, 400);
    assert.ok(/not classified in policy/.test(r.body.detail));
  } finally { await ctx.close(); }
});

test('skills validation: shell metachars rejected in argsTemplate literals', async () => {
  for (const bad of ['ls; rm -rf /', 'echo `id`', 'curl $HOME', 'a | b', 'a && b', 'x > /etc/x', 'x < y']) {
    assert.throws(() => validateTemplate(bad), undefined, `template '${bad}' must be rejected`);
    assert.ok(METACHAR_RE.test(bad));
  }
  assert.deepEqual(validateTemplate('{"cmd":"list {{dir}} --brief"}'), ['dir']);

  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const r = await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      ...GOOD_SKILL,
      steps: [{ tool: 'shell.run', argsTemplate: 'ls; rm -rf /' }],
    });
    assert.equal(r.status, 400);
  } finally { await ctx.close(); }
});

test('skills run: placeholder VALUES containing shell metachars are rejected', async () => {
  assert.deepEqual(resolveTemplate('{"cmd":"echo {{msg}}"}', { msg: 'hello world' }), { cmd: 'echo hello world' });
  assert.throws(() => resolveTemplate('{"cmd":"echo {{msg}}"}', { msg: 'a;b' }), /metacharacters/);
  assert.throws(() => resolveTemplate('{"cmd":"echo {{msg}}"}', { msg: '`id`' }), /metacharacters/);
  assert.throws(() => resolveTemplate('{"cmd":"echo {{msg}}"}', { msg: '$PATH' }), /metacharacters/);
  assert.throws(() => resolveTemplate('{"cmd":"echo {{msg}}"}', {}), /missing skill args/);
});

// ── dry run ──────────────────────────────────────────────────────

test('skills dry-run: ?dry=1 returns the plan and executes NOTHING', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      name: 'deploy-check',
      version: '0.2.0',
      description: 'read then propose a deploy',
      steps: [
        { tool: 'fs.read:notes.md', argsTemplate: '' },
        { tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}', approvalHint: 'destructive' },
      ],
    })).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-atlas', { args: { target: 'staging' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'planned');
    assert.equal(r.body.dry, true);
    assert.equal(r.body.plan.length, 2);
    assert.equal(r.body.plan[0].seq, 1);
    assert.equal(r.body.plan[0].tool, 'fs.read:notes.md');
    assert.equal(r.body.plan[0].cls, 'read');
    assert.equal(r.body.plan[1].tool, 'shell.run');
    assert.equal(r.body.plan[1].cls, 'destructive');
    assert.deepEqual(r.body.plan[1].args, { cmd: 'deploy staging' });
    assert.equal(dispatchCalls.length, 0, 'nothing dispatched on dry run');
    assert.equal(ctx.gw().approvals.listPending().length, 0, 'no approvals requested on dry run');
  } finally { await ctx.close(); }
});

// ── governed execution ───────────────────────────────────────────

test('skills run: read step is allowed and dispatched through gw.dispatch', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', GOOD_SKILL)).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-atlas', { args: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'completed');
    assert.equal(r.body.steps[0].decision, 'allow');
    assert.deepEqual(r.body.steps[0].result, { ok: true, tool: 'fs.read:notes.md' });
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].tool, 'fs.read:notes.md');

    const kinds = ctx.gw().chain.entries.map((e) => e.payload);
    const stepRows = kinds.filter((p) => p.type === 'chat_action' && p.kind === 'skill_step');
    assert.equal(stepRows.length, 1);
    assert.equal(stepRows[0].seq, 1);
    assert.equal(stepRows[0].decision, 'allow');
    assert.equal(stepRows[0].skillId, skill.id);
    assert.ok(stepRows[0].argsLength >= 0);
    assert.equal(Object.hasOwn(stepRows[0], 'args'), false, 'no raw args in chain');
    const started = kinds.filter((p) => p.type === 'skill_run_started');
    assert.equal(started.length, 1);
  } finally { await ctx.close(); }
});

test('skills run: destructive step parks as approval — NEVER direct execution', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      name: 'drop-staging',
      version: '1.0.0',
      description: 'destructive on purpose',
      steps: [{ tool: 'shell.run', argsTemplate: '{"cmd":"rm {{path}}"}', approvalHint: 'destructive — operator review' }],
    })).body;
    // operator bot has capability '*' but destructive STILL requires approval
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-atlas', { args: { path: 'staging/db.sqlite' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'parked');
    assert.equal(r.body.steps[0].decision, 'needs_approval');
    assert.ok(r.body.steps[0].approvalId);
    assert.equal(dispatchCalls.length, 0, 'destructive step never dispatched');

    const pending = ctx.gw().approvals.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, 'shell.run');
    assert.equal(pending[0].args.cmd, 'rm staging/db.sqlite', 'approval carries resolved args for the governed path');

    const stepRows = ctx.gw().chain.entries.map((e) => e.payload)
      .filter((p) => p.type === 'chat_action' && p.kind === 'skill_step');
    assert.equal(stepRows.length, 1);
    assert.equal(stepRows[0].decision, 'needs_approval');
  } finally { await ctx.close(); }
});

test('skills run: multi-step skill stops at the first parked step', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      name: 'deploy-pipeline',
      version: '1.0.0',
      description: 'read then destructive',
      steps: [
        { tool: 'fs.read:notes.md', argsTemplate: '' },
        { tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}' },
      ],
    })).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-sky', { args: { target: 'prod' } });
    assert.equal(r.body.status, 'parked');
    assert.equal(r.body.completed, 1, 'step 1 executed');
    assert.equal(r.body.steps.length, 2, 'step 2 is the parked approval');
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].tool, 'fs.read:notes.md');
  } finally { await ctx.close(); }
});

test('skills run: run with a missing placeholder arg → 400, nothing runs', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      ...GOOD_SKILL,
      steps: [{ tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}' }],
    })).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-atlas', { args: {} });
    assert.equal(r.status, 400);
    assert.ok(/missing skill args/.test(r.body.detail));
    assert.equal(dispatchCalls.length, 0);
  } finally { await ctx.close(); }
});

// ── chain hygiene: no raw args anywhere in the audit chain ──────

test('skills chain hygiene: audit chain never contains raw arg values', async () => {
  const RAW = 'CORPSECRET7';
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      name: 'search-corpus',
      version: '1.0.0',
      description: 'run a search with an argument',
      steps: [{ tool: 'fs.read:notes.md', argsTemplate: '{"cmd":"lookup {{query}}"}' }],
    })).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-atlas', { args: { query: RAW } });
    const dumped = JSON.stringify(ctx.gw().chain.entries.map((e) => e.payload));
    assert.ok(!dumped.includes(RAW), 'raw arg value must never appear in the chain');
    const started = ctx.gw().chain.entries.map((e) => e.payload).find((p) => p.type === 'skill_run_started');
    assert.ok(started, 'run started audited');
    assert.ok(Object.hasOwn(started, 'args') === false, 'run_started carries no args');
  } finally { await ctx.close(); }
});

test('skills: unknown skill id on run → 404', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const r = await api(url, 'POST', '/v2/skills/sk_deadbeef/run', 'tok-atlas', { args: {} });
    assert.equal(r.status, 404);
  } finally { await ctx.close(); }
});

// ── policy integration regression guard ─────────────────────────

test('skills: policy decide unchanged — destructive needs approval even with caps', () => {
  const bot = { name: 'x', capabilities: ['*'] };
  assert.equal(decide({ tool: 'shell.run', cls: classify('shell.run'), bot }).decision, 'needs_approval');
  assert.equal(decide({ tool: 'fs.read:notes.md', cls: classify('fs.read:notes.md'), bot }).decision, 'allow');
});
