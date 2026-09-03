'use strict';
// FS-F4 — skills marketplace: publish/unpublish, shared catalog, cross-bot runs.
//
// Covers: operator-only publish/unpublish (audited skill_published /
// skill_unpublished, worker refusal → 403 skill_denied), the read-only
// GET /v2/skills/shared projection (no steps, no description), cross-bot
// dry-runs of SHARED skills, non-owner real runs still 403 dry_run_only,
// unpublish re-hiding a skill (404 anti-enum restored), private-by-default
// byte-identical behavior, and the audit rows for the whole lifecycle.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { isShared, canViewSkill } = require('../src/gateway/skills');

// ── HTTP harness (mirrors skills-selfservice.test.js) ────────────

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
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      wren: { name: 'wren', token: 'tok-wren', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      orion: { name: 'orion', token: 'tok-orion', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mkt-'));
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

function cleanup(ctx) {
  require('node:fs').rmSync(ctx.gw().__dir, { recursive: true, force: true });
}

// ── unit: visibility helpers ─────────────────────────────────────

test('skills marketplace: visibility helper units', () => {
  assert.equal(isShared({ visibility: 'shared' }), true);
  assert.equal(isShared({ visibility: 'private' }), false);
  assert.equal(isShared({}), false, 'no visibility field → private (default)');
  assert.equal(isShared(null), false);

  const self = { name: 'wren' };
  const skill = { createdBy: 'orion', visibility: 'shared' };
  assert.equal(canViewSkill(skill, self, 'self'), true, 'self tier sees shared skills');
  assert.equal(canViewSkill({ ...skill, visibility: 'private' }, self, 'self'), false, 'self tier does NOT see private skills');
  assert.equal(canViewSkill(skill, self, null), false, 'no tier → nothing');
  assert.equal(canViewSkill({ ...skill, createdBy: 'wren' }, self, 'self'), true, 'owner always sees its own');
  assert.equal(canViewSkill({ ...skill, visibility: 'private' }, self, 'operator'), true, 'operator sees everything (FS-C1)');
  assert.equal(canViewSkill(null, self, 'operator'), false);
});

// ── publish / unpublish lifecycle ────────────────────────────────

test('marketplace: operator publishes + unpublishes; worker refusal is 403 + audited', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', GOOD_SKILL)).body;

    // owner is NOT an operator → publish refused, audited
    const ownerPub = await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-wren');
    assert.equal(ownerPub.status, 403);
    assert.equal(ownerPub.body.error, 'operator_required');

    // a worker with NO skills access at all → 403 skill_owner_required (FS-F1 gate first)
    const forgePub = await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-forge');
    assert.equal(forgePub.status, 403);
    assert.equal(forgePub.body.error, 'skill_owner_required');

    // operator publishes
    const pub = await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas');
    assert.equal(pub.status, 200);
    assert.equal(pub.body.visibility, 'shared');
    assert.equal(pub.body.id, skill.id);

    // operator unpublishes
    const unpub = await api(url, 'POST', `/v2/skills/${skill.id}/unpublish`, 'tok-atlas');
    assert.equal(unpub.status, 200);
    assert.equal(unpub.body.visibility, 'private');

    // publish a missing id → 404
    const missing = await api(url, 'POST', '/v2/skills/sk_12345678/publish', 'tok-atlas');
    assert.equal(missing.status, 404);

    const audit = ctx.gw().chain.entries.map((e) => e.payload);
    const published = audit.filter((p) => p.type === 'skill_published');
    assert.equal(published.length, 1, 'skill_published audited');
    assert.equal(published[0].id, skill.id);
    assert.equal(published[0].by, 'atlas');
    const unpublished = audit.filter((p) => p.type === 'skill_unpublished');
    assert.equal(unpublished.length, 1, 'skill_unpublished audited');
    assert.equal(unpublished[0].id, skill.id);
    assert.equal(unpublished[0].by, 'atlas');

    // worker publish refusals are audited skill_denied with the action name
    const denied = audit.filter((p) => p.type === 'skill_denied');
    assert.ok(denied.some((d) => d.bot === 'wren' && d.action === 'publish' && d.skillId === skill.id), 'owner publish refusal audited');
    assert.ok(denied.some((d) => d.bot === 'forge'), 'no-cap refusal audited');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

// ── shared catalog projection ────────────────────────────────────

test('marketplace: GET /v2/skills/shared lists shared skills with no steps/private fields', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const priv = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-private-a' })).body;
    const shared = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-shared-a' })).body;
    await api(url, 'POST', `/v2/skills/${shared.id}/publish`, 'tok-atlas');

    const list = await api(url, 'GET', '/v2/skills/shared', 'tok-orion');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 1, 'only the shared skill appears');
    const row = list.body.skills[0];
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'owner', 'version', 'visibility'], 'exact read-only projection');
    assert.equal(row.id, shared.id);
    assert.equal(row.owner, 'wren');
    assert.equal(row.visibility, 'shared');
    assert.equal(row.steps, undefined, 'no steps in the projection');
    assert.equal(row.description, undefined, 'no description in the projection');
    assert.equal(row.createdBy, undefined, 'no createdBy field — owner only');

    // even a worker with no skills cap sees the catalog? No — the skills
    // surface gate applies: forge has no tier → 403 skill_owner_required.
    const forge = await api(url, 'GET', '/v2/skills/shared', 'tok-forge');
    assert.equal(forge.status, 403);
    assert.equal(forge.body.error, 'skill_owner_required');

    // the private skill is NOT in the shared list and unchanged
    const opList = await api(url, 'GET', '/v2/skills', 'tok-atlas');
    const privRow = opList.body.skills.find((s) => s.id === priv.id);
    assert.equal(privRow.visibility, undefined, 'private default: no visibility field materializes on create');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

// ── cross-bot run semantics ──────────────────────────────────────

test('marketplace: non-owner can GET + dry-run a shared skill; nothing dispatched on dry', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', {
      ...GOOD_SKILL,
      name: 'wren-deploy-plan',
      steps: [{ tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}', approvalHint: 'destructive' }],
    })).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas');

    // non-owner (orion, skills.own) can read the shared record
    const get = await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-orion');
    assert.equal(get.status, 200);
    assert.equal(get.body.createdBy, 'wren');

    // and dry-run it
    const dry = await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-orion', { args: { target: 'staging' } });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.status, 'planned');
    assert.equal(dry.body.dry, true);
    assert.equal(dry.body.plan[0].cls, 'destructive');
    assert.equal(dispatchCalls.length, 0, 'nothing dispatched on dry run');
    assert.equal(ctx.gw().approvals.listPending().length, 0, 'no approvals on dry run');

    const started = ctx.gw().chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.equal(started.length, 1);
    assert.equal(started[0].bot, 'orion', 'cross-bot run recorded with the runner, not the owner');
    assert.equal(started[0].dry, true);
    cleanup(ctx);
  } finally { await ctx.close(); }
});

test('marketplace: non-owner real run of a shared skill → 403 dry_run_only (unchanged), audited', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', {
      ...GOOD_SKILL,
      name: 'wren-live-shared',
      steps: [{ tool: 'fs.read:notes.md', argsTemplate: '' }],
    })).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas');

    const r = await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-orion', { args: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'dry_run_only');
    assert.equal(dispatchCalls.length, 0, 'live run never dispatched for self-service, even on shared skills');
    assert.equal(ctx.gw().approvals.listPending().length, 0);

    const denied = ctx.gw().chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].bot, 'orion');
    assert.equal(denied[0].skillId, skill.id);
    assert.equal(denied[0].action, 'run');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

test('marketplace: a non-owner can never edit or delete a shared skill (404)', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', GOOD_SKILL)).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas');

    const patch = await api(url, 'PATCH', `/v2/skills/${skill.id}`, 'tok-orion', { version: '9.9.9' });
    assert.equal(patch.status, 404, 'shared ≠ editable — non-owner patch is 404');
    const del = await api(url, 'DELETE', `/v2/skills/${skill.id}`, 'tok-orion');
    assert.equal(del.status, 404, 'shared ≠ deletable — non-owner delete is 404');

    // the record is untouched
    const opGet = await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-atlas');
    assert.equal(opGet.status, 200);
    assert.equal(opGet.body.version, '1.0.0');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

// ── unpublish re-hides (anti-enum restored) ──────────────────────

test('marketplace: unpublish re-hides the skill — 404 anti-enum restored, gone from catalog', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-cycle' })).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas');
    assert.equal((await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-orion')).status, 200);

    await api(url, 'POST', `/v2/skills/${skill.id}/unpublish`, 'tok-atlas');

    const get = await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-orion');
    assert.equal(get.status, 404, 'anti-enum restored after unpublish');
    const dry = await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-orion', { args: {} });
    assert.equal(dry.status, 404, 'run lookup is anti-enum too');
    const list = await api(url, 'GET', '/v2/skills/shared', 'tok-orion');
    assert.equal(list.body.skills.length, 0, 'gone from the shared catalog');

    // owner still sees + can still dry-run its own private skill
    const ownerGet = await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-wren');
    assert.equal(ownerGet.status, 200);
    assert.equal(ownerGet.body.visibility, 'private');
    const ownerDry = await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-wren', { args: {} });
    assert.equal(ownerDry.status, 200);
    assert.equal(ownerDry.body.status, 'planned');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

// ── private default is byte-identical FS-F1 behavior ─────────────

test('marketplace: private default byte-identical — other-owner private skills stay invisible everywhere', async () => {
  const dispatchCalls = [];
  const ctx = buildServer();
  ctx.attach(isolatedGW({ dispatchCalls }));
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-still-private' })).body;

    const list = await api(url, 'GET', '/v2/skills', 'tok-orion');
    assert.equal(list.status, 200);
    assert.equal(list.body.skills.length, 0, 'self-service list still shows ONLY own skills');
    assert.equal((await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-orion')).status, 404);
    assert.equal((await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-orion', { args: {} })).status, 404);
    assert.equal((await api(url, 'PATCH', `/v2/skills/${skill.id}`, 'tok-orion', { version: '2.0.0' })).status, 404);
    assert.equal((await api(url, 'DELETE', `/v2/skills/${skill.id}`, 'tok-orion')).status, 404);
    assert.equal((await api(url, 'GET', '/v2/skills/shared', 'tok-orion')).body.skills.length, 0);
    assert.equal(dispatchCalls.length, 0);

    // no visibility field exists on a plain create — stored record is
    // byte-identical to pre-FS-F4 (id/name/version/description/steps/
    // createdBy/createdAt only)
    const opGet = await api(url, 'GET', `/v2/skills/${skill.id}`, 'tok-atlas');
    assert.deepEqual(Object.keys(opGet.body).sort(),
      ['createdAt', 'createdBy', 'description', 'id', 'name', 'steps', 'version'],
      'created skill has NO visibility field — private is the absence, not a new field');
    cleanup(ctx);
  } finally { await ctx.close(); }
});

// ── audit rows present for the full lifecycle ────────────────────

test('marketplace: audit chain carries every lifecycle row', async () => {
  const ctx = buildServer();
  ctx.attach(isolatedGW());
  const url = await listen(ctx.server);
  try {
    const skill = (await api(url, 'POST', '/v2/skills', 'tok-wren', { ...GOOD_SKILL, name: 'wren-audit-cycle' })).body;
    await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-orion', { args: {} }); // 404 anti-enum — NOT audited by design
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-wren'); // 403 skill_denied {action:'publish'}
    await api(url, 'POST', `/v2/skills/${skill.id}/publish`, 'tok-atlas'); // 200 skill_published
    await api(url, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-orion', { args: {} }); // 200 skill_run_started
    await api(url, 'POST', `/v2/skills/${skill.id}/run`, 'tok-orion', { args: {} }); // 403 skill_denied {action:'run'}
    await api(url, 'POST', `/v2/skills/${skill.id}/unpublish`, 'tok-atlas'); // 200 skill_unpublished

    const payloads = ctx.gw().chain.entries.map((e) => e.payload);
    const types = payloads.map((p) => p.type);
    assert.ok(types.includes('skill_created'));
    assert.ok(types.includes('skill_published'));
    assert.ok(types.includes('skill_run_started'));
    assert.ok(types.includes('skill_unpublished'));

    // exactly two denials: the owner publish refusal + the non-owner live
    // run refusal. The private dry-run attempt is a 404 anti-enum (silent,
    // byte-identical FS-F1) — never an audit row.
    const denied = payloads.filter((p) => p.type === 'skill_denied');
    assert.equal(denied.length, 2);
    assert.deepEqual(denied.map((d) => d.action).sort(), ['publish', 'run']);
    assert.ok(denied.every((d) => d.skillId === skill.id));
    cleanup(ctx);
  } finally { await ctx.close(); }
});
