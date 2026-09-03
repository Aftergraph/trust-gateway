'use strict';
// FS-F1 — skills self-service for non-operators.
//
// Covers: the 'skills.own' bot capability (access tier 'self' in
// skills.js) — create scoped owner=bot.name, list/get/patch/delete OWN
// skills only, dry-only runs (non-dry → 403 skill_denied audited),
// 404 anti-enumeration on other bots' records, ownership enforcement on
// delete, 403 skill_owner_required for bots with neither cap, and the
// operator/author FS-C1 behavior remaining byte-identical.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { skillsAccessLevel, isOwnSkill } = require('../src/gateway/skills');

// ── HTTP harness (mirrors skills.test.js) ────────────────────────

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

function makeGateway({ dispatchCalls = [], skillsFile = null } = {}) {
  const dispatch = async (botName, tool, args) => {
    dispatchCalls.push({ bot: botName, tool, args });
    return { ok: true, tool };
  };
  const gw = new Gateway({
    bots: {
      // worker with NOTHING relevant → fail closed
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      // worker with the self-service cap
      wren: { name: 'wren', token: 'tok-wren', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
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

let tmpCounter = 0;
function isolatedGW(opts = {}) {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-own-'));
  const gw = makeGateway({ skillsFile: path.join(dir, `skills-${process.pid}-${++tmpCounter}.json`), ...opts });
  gw.__dir = dir;
  return gw;
}

const GOOD_SKILL = {
  name: 'wren-notes-read',
  version: '1.0.0',
  description: 'read a notes file',
  steps: [{ tool: 'fs.read:notes.md', argsTemplate: '' }],
};

// ── tier helper unit checks ──────────────────────────────────────

test('skills self-service: skillsAccessLevel tiers', () => {
  assert.equal(skillsAccessLevel({ name: 'a', role: 'operator' }), 'operator');
  assert.equal(skillsAccessLevel({ name: 'a', role: 'worker', capabilities: ['skill.author'] }), 'author');
  assert.equal(skillsAccessLevel({ name: 'a', role: 'worker', capabilities: ['skills.own'] }), 'self');
  assert.equal(skillsAccessLevel({ name: 'a', role: 'worker', capabilities: ['skill.author', 'skills.own'] }), 'author', 'skill.author wins over skills.own');
  assert.equal(skillsAccessLevel({ name: 'a', role: 'worker', capabilities: ['fs.read'] }), null);
  assert.equal(skillsAccessLevel({ name: 'a', role: 'worker', capabilities: ['*'] }), null, '* does NOT widen the skills surface (FS-C1 contract preserved)');
  assert.equal(skillsAccessLevel(null), null);
  assert.equal(isOwnSkill({ createdBy: 'wren' }, { name: 'wren' }), true);
  assert.equal(isOwnSkill({ createdBy: 'atlas' }, { name: 'wren' }), false);
  assert.equal(isOwnSkill(null, { name: 'wren' }), false);
  assert.equal(isOwnSkill({ createdBy: 'wren' }, null), false);
});

// ── self-service lifecycle ───────────────────────────────────────

test('skills.own: worker can create (owner forced to bot.name) → list-own → get-own → patch-own → delete-own', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    // createdBy spoof attempt is ignored — owner is always bot.name
    const created = await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, createdBy: 'atlas' });
    assert.equal(created.status, 201);
    assert.equal(created.body.createdBy, 'wren', 'owner is forced to bot.name');

    const list = await api(url, 'GET', '/v2/skills', 'tok-wren');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 1, 'sees exactly its own skill');
    assert.equal(list.body.skills[0].createdBy, 'wren');

    const one = await api(url, 'GET', `/v2/skills/${created.body.id}`, 'tok-wren');
    assert.equal(one.status, 200);
    assert.equal(one.body.id, created.body.id);

    const patched = await api(url, 'PATCH', `/v2/skills/${created.body.id}`, 'tok-wren', { version: '1.1.0' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.version, '1.1.0');
    assert.equal(patched.body.createdBy, 'wren', 'createdBy immutable on patch');

    const gone = await api(url, 'DELETE', `/v2/skills/${created.body.id}`, 'tok-wren');
    assert.equal(gone.status, 200);
    assert.equal(gone.body.id, created.body.id);
    assert.equal((await api(url, 'GET', `/v2/skills/${created.body.id}`, 'tok-wren')).status, 404);

    const audit = ctx.gw().chain.entries.map((e) => e.payload);
    const createdRow = audit.find((p) => p.type === 'skill_created');
    assert.ok(createdRow, 'skill_created audited');
    assert.equal(createdRow.owner, 'wren', 'skill_created carries the owner field');

    const dir = require('node:fs'), os = require('node:os'), path = require('node:path');
    dir.rmSync(ctx.gw().__dir, { recursive: true, force: true });
  } finally { await ctx.close(); }
});

test('skills.own: dry-run of OWN skill returns the plan and executes nothing', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', {
      ...GOOD_SKILL,
      name: 'wren-dry-plan',
      steps: [{ tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}', approvalHint: 'destructive' }],
    })).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-wren', { args: { target: 'staging' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'planned');
    assert.equal(r.body.dry, true);
    assert.equal(r.body.plan.length, 1);
    assert.equal(r.body.plan[0].cls, 'destructive');
    assert.equal(dispatchCalls.length, 0, 'nothing dispatched on dry run');
    assert.equal(ctx.gw().approvals.listPending().length, 0, 'no approvals requested on dry run');

    const dir = require('node:fs');
    dir.rmSync(ctx.gw().__dir, { recursive: true, force: true });
  } finally { await ctx.close(); }
});

// ── dry-only enforcement ─────────────────────────────────────────

test('skills.own: non-dry run on OWN skill → 403, skill_denied audited, nothing dispatched', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', GOOD_SKILL)).body;
    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-wren', { args: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'dry_run_only');
    assert.equal(dispatchCalls.length, 0, 'live run never dispatched for self-service');
    assert.equal(ctx.gw().approvals.listPending().length, 0, 'no approvals requested');

    const denied = ctx.gw().chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].bot, 'wren');
    assert.equal(denied[0].skillId, skill.id);
    assert.equal(denied[0].action, 'run');

    const dir = require('node:fs');
    dir.rmSync(ctx.gw().__dir, { recursive: true, force: true });
  } finally { await ctx.close(); }
});

// ── no cap → fail closed everywhere ──────────────────────────────

test('skills.own: worker WITHOUT the cap gets 403 skill_owner_required on every route (audited)', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const list = await api(url, 'GET', '/v2/skills', 'tok-forge');
    assert.equal(list.status, 403);
    assert.equal(list.body.error, 'skill_owner_required');
    const create = await api(url, 'POST', '/v2/skills', 'tok-forge', GOOD_SKILL);
    assert.equal(create.status, 403);
    const patch = await api(url, 'PATCH', '/v2/skills/sk_12345678', 'tok-forge', { version: '2.0.0' });
    assert.equal(patch.status, 403);
    const del = await api(url, 'DELETE', '/v2/skills/sk_12345678', 'tok-forge');
    assert.equal(del.status, 403);
    const run = await api(url, 'POST', '/v2/skills/sk_12345678/run?dry=1', 'tok-forge', { args: {} });
    assert.equal(run.status, 403);

    const denied = ctx.gw().chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_denied');
    assert.equal(denied.length, 5, 'every refusal audited');
    assert.deepEqual(denied.map((d) => d.action).sort(), ['create', 'delete', 'list', 'patch', 'run']);
    assert.ok(denied.every((d) => d.bot === 'forge'));
  } finally { await ctx.close(); }
});

// ── anti-enumeration + ownership enforcement ─────────────────────

test('skills.own: worker cannot read/list/patch/delete/run an operator skill (404 anti-enum)', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const opSkill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      ...GOOD_SKILL,
      name: 'atlas-private-skill',
    })).body;

    const list = await api(url, 'GET', '/v2/skills', 'tok-wren');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 0, 'operator skill is not in the self-service list');

    const get = await api(url, 'GET', `/v2/skills/${opSkill.id}`, 'tok-wren');
    assert.equal(get.status, 404, 'anti-enum: same 404 as a missing skill');
    const patch = await api(url, 'PATCH', `/v2/skills/${opSkill.id}`, 'tok-wren', { version: '9.9.9' });
    assert.equal(patch.status, 404);
    const run = await api(url, 'POST', `/v2/skills/${opSkill.id}/run?dry=1`, 'tok-wren', { args: {} });
    assert.equal(run.status, 404);
    const del = await api(url, 'DELETE', `/v2/skills/${opSkill.id}`, 'tok-wren');
    assert.equal(del.status, 404, 'ownership enforced on delete — cannot delete someone else\'s');

    // the operator's skill is untouched by every attempt above
    const opGet = await api(url, 'GET', `/v2/skills/${opSkill.id}`, 'tok-atlas');
    assert.equal(opGet.status, 200);
    assert.equal(opGet.body.version, '1.0.0');
    assert.equal(dispatchCalls.length, 0);
    assert.equal(ctx.gw().approvals.listPending().length, 0);

    const dir = require('node:fs');
    dir.rmSync(ctx.gw().__dir, { recursive: true, force: true });
  } finally { await ctx.close(); }
});

// ── operator unchanged ───────────────────────────────────────────

test('skills.own: operator behavior unchanged — sees ALL skills, createdBy override intact, live runs allowed', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const wrenSkill = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-own-a' })).body;
    const opSkill = (await api(url, 'POST', '/v2/skills', 'tok-atlas', {
      ...GOOD_SKILL,
      name: 'atlas-live-run',
      createdBy: 'someone-else',
    })).body;
    assert.equal(opSkill.createdBy, 'someone-else', 'operator createdBy override still honored');

    const list = await api(url, 'GET', '/v2/skills', 'tok-atlas');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 2, 'operator sees every skill');
    assert.ok(list.body.skills.some((s) => s.id === wrenSkill.id));
    assert.ok(list.body.skills.some((s) => s.id === opSkill.id));

    // live (non-dry) run still works for the operator
    const r = await api(url, 'POST', `/v2/skills/${opSkill.id}/run`, 'tok-atlas', { args: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'completed');
    assert.equal(dispatchCalls.length, 1);

    // dry-only refusal is tier-scoped: it never applies to the operator
    const dry = await api(url, 'POST', `/v2/skills/${wrenSkill.id}/run?dry=1`, 'tok-atlas', { args: {} });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.status, 'planned');

    // operator can still delete a self-service skill
    const del = await api(url, 'DELETE', `/v2/skills/${wrenSkill.id}`, 'tok-atlas');
    assert.equal(del.status, 200);

    const dir = require('node:fs');
    dir.rmSync(ctx.gw().__dir, { recursive: true, force: true });
  } finally { await ctx.close(); }
});