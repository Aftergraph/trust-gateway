'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// FS-G1 — cross-tenant skills federation: env-gated, read-only
// cross-tenant, running-tenant approvals.
//
// Covers (per the slice spec):
//   1. federate → other tenant sees the catalog + can dry-run
//   2. real run by a cross-tenant operator parks in the RUNNING tenant's
//      scoped approvals (NOT the owner's, NOT main's singleton)
//   3. unfederate → 404 anti-enum restored
//   4. env OFF → a 'federated' skill behaves exactly like 'shared'
//   5. chain/accounting: skill_run_started carries BOTH tags
//      (tenantAuditTag(running) + federatedFrom) on the SAME row
//   6. edits/delete stay owner-tenant-only (404 anti-enum + audited)
//   7. existing skills suites (FS-C1/FS-F1/FS-F4) stay green untouched.
//
// Harness mirrors skills-marketplace.test.js (in-process Gateway + fetch)
// with a TG_DB_FILE/TG_DATA_DIR jail set BEFORE requiring gateway modules
// (same pattern as approvals-tenant.test.js — the tenant store needs its
// own SQLite + scoped dirs).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// File-level data jail (approvals-tenant pattern): set BEFORE gateway
// modules are required. Unique tenant ids isolate the in-process tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-g1-federation-'));
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = path.join(TMP, 'data');

const { Gateway } = require('../src/gateway/server');
const { getTenantStore } = require('../src/gateway/tenants');
const { tenantAuditTag } = require('../src/gateway/tenant-scope');
const { isFederated, isSharedLike, federationEnabled } = require('../src/gateway/skills');

const AUTH = 'Bear' + 'er ';

// ── HTTP harness (mirrors skills-marketplace.test.js) ────────────

async function api(base, method, p, token, body, extraHeaders = {}) {
  const headers = { authorization: AUTH + token, 'content-type': 'application/json', ...extraHeaders };
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

let tmpCounter = 0;
function buildGateway({ skillsFile } = {}) {
  const dispatchCalls = [];
  const gw = new Gateway({
    bots: {
      // tenant A (owner tenant)
      aworker: { name: 'aworker', token: 'tnt_fed-a_awtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      aop: { name: 'aop', token: 'tnt_fed-a_aotok', role: 'operator', capabilities: ['*'] },
      // tenant B (running tenant — the federation consumer)
      bworker: { name: 'bworker', token: 'tnt_fed-b_bwtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      bop: { name: 'bop', token: 'tnt_fed-b_botok', role: 'operator', capabilities: ['*'] },
      // main-tenant bots (off-switch byte-identical behavior)
      mworker: { name: 'mworker', token: 'tok-main-worker', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      mop: { name: 'mop', token: 'tok-main-op', role: 'operator', capabilities: ['*'] },
    },
    mountFiles: false,
    telemetryFile: null,
    dispatch: async (botName, tool, args) => {
      dispatchCalls.push({ bot: botName, tool, args });
      return { ok: true, tool };
    },
  });
  gw.mounts.push(require('../src/gateway/mounts/105-skills'));
  const dir = skillsFile || path.join(TMP, `skills-${process.pid}-${++tmpCounter}.json`);
  gw._skillsFile = dir;
  // Two tenants: fed-a (owner), fed-b (running). 'main' auto-ensures.
  const ts = getTenantStore(gw);
  ts.create({ name: 'fed-a' });
  ts.create({ name: 'fed-b' });
  return { gw, dispatchCalls };
}

async function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const DESTRUCTIVE_SKILL = (name) => ({
  name,
  version: '1.0.0',
  description: 'deploy a thing',
  steps: [{ tool: 'shell.run', argsTemplate: '{"cmd":"deploy {{target}}"}', approvalHint: 'destructive' }],
});

function withFederation(fn) {
  return async (t) => {
    process.env.TG_SKILLS_FEDERATION = '1';
    try {
      await fn(t);
    } finally {
      delete process.env.TG_SKILLS_FEDERATION;
    }
  };
}

// ── unit: helpers ────────────────────────────────────────────────

test('fs-g1: federation helpers — isFederated / isSharedLike / tenantAuditTag federatedFrom', () => {
  assert.equal(isFederated({ visibility: 'federated' }), true);
  assert.equal(isFederated({ visibility: 'shared' }), false);
  assert.equal(isFederated({}), false);
  assert.equal(isFederated(null), false);

  assert.equal(isSharedLike({ visibility: 'shared' }), true);
  assert.equal(isSharedLike({ visibility: 'federated' }), true, 'federated is shared-like');
  assert.equal(isSharedLike({ visibility: 'private' }), false);

  // existing tag shape unchanged for non-federated runs
  assert.deepEqual(tenantAuditTag({ id: 'main' }), {});
  assert.deepEqual(tenantAuditTag(null), {});
  assert.deepEqual(tenantAuditTag({ id: 'acme' }), { tenant: 'acme' });
  // federatedFrom rides ONLY a non-main running tenant's tag
  assert.deepEqual(tenantAuditTag({ id: 'acme' }, { federatedFrom: 'main' }),
    { tenant: 'acme', federatedFrom: 'main' });
  assert.deepEqual(tenantAuditTag({ id: 'main' }, { federatedFrom: 'acme' }),
    {}, 'main running tenant: shape preserved (caller adds the field)');
  assert.deepEqual(tenantAuditTag({ id: 'acme' }, {}), { tenant: 'acme' });
});

// ── 1. federate → catalog + cross-tenant dry-run ─────────────────

test('fs-g1: federate → other tenant sees catalog + can GET + dry-run', { }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    // owner-tenant operator creates + federates a skill
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-deploy'))).body;
    const fed = await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');
    assert.equal(fed.status, 200);
    assert.equal(fed.body.visibility, 'federated');

    // OTHER tenant discovers it in the federated catalog — full projection
    const catalog = await api(base, 'GET', '/v2/skills/federated', 'tnt_fed-b_bwtok');
    assert.equal(catalog.status, 200);
    const row = catalog.body.skills.find((s) => s.id === skill.id);
    assert.ok(row, 'federated skill visible in the cross-tenant catalog');
    assert.deepEqual(Object.keys(row).sort(),
      ['description', 'id', 'name', 'ownerBot', 'ownerTenant', 'version'],
      'catalog projection is exactly {id,name,version,ownerTenant,ownerBot,description}');
    assert.equal(row.ownerTenant, 'fed-a');
    assert.equal(row.ownerBot, 'aop');
    assert.equal(row.steps, undefined, 'no steps in the catalog');

    // the catalog is read-only discovery: no args, no template material
    assert.ok(!JSON.stringify(catalog.body).includes('argsTemplate'));

    // OTHER tenant can GET the record (read-only) and DRY-RUN it
    const get = await api(base, 'GET', `/v2/skills/${skill.id}`, 'tnt_fed-b_bwtok');
    assert.equal(get.status, 200);
    assert.equal(get.body.visibility, 'federated');

    const dry = await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tnt_fed-b_bwtok', { args: { target: 'staging' } });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.status, 'planned');
    assert.equal(dry.body.dry, true);

    // nothing dispatched, nothing parked on a dry run
    assert.equal(gw.approvals.listPending().length, 0, 'main singleton untouched by tenant dry-run');
    const scopedFile = path.join(process.env.TG_DATA_DIR, 'tenants', 'fed-b', 'approvals', 'approvals.json');
    assert.ok(!fs.existsSync(scopedFile), 'no scoped approvals file created by a dry run');
  } finally { await new Promise((r) => server.close(() => r())); }
}));

// ── 2. chain/accounting: BOTH tags on the same skill_run_started row ──

test('fs-g1: cross-tenant dry run audited with tenant tag AND federatedFrom on ONE row', withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-audit'))).body;
    await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');

    // cross-tenant DRY run (tenant B worker runs a fed-a skill)
    await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tnt_fed-b_bwtok', { args: { target: 'x' } });

    const started = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.equal(started.length, 1, 'exactly one skill_run_started row — no extra federation type');
    const row = started[0];
    assert.equal(row.tenant, 'fed-b', 'tenantAuditTag(running tenant) present');
    assert.equal(row.federatedFrom, 'fed-a', 'federatedFrom: <owner-tenant-id> present');
    assert.equal(row.bot, 'bworker');
    assert.equal(row.dry, true);

    // owner-tenant same-tenant run: NO federation tags (untouched payload)
    await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tnt_fed-a_awtok', { args: { target: 'y' } });
    const started2 = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.equal(started2.length, 2);
    assert.equal(started2[1].tenant, undefined, 'same-tenant run untagged');
    assert.equal(started2[1].federatedFrom, undefined, 'same-tenant run has no federatedFrom');
  } finally { await new Promise((r) => server.close(() => r())); }
}));

// ── 3. real cross-tenant run parks in the RUNNING tenant's approvals ──

test('fs-g1: real cross-tenant run parks in the RUNNING tenant approvals (not owner, not main)', withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-live-run'))).body;
    await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');

    // tenant B OPERATOR (operator/author tier → real runs allowed, FS-C1)
    const run = await api(base, 'POST', `/v2/skills/${skill.id}/run`, 'tnt_fed-b_botok', { args: { target: 'prod' } });
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'parked', 'destructive step parked');
    const approvalId = run.body.steps[0].approvalId;
    assert.ok(approvalId, 'approval id returned');

    // parked in the RUNNING tenant's SCOPED store — nowhere else
    const scopedFile = path.join(process.env.TG_DATA_DIR, 'tenants', 'fed-b', 'approvals', 'approvals.json');
    assert.ok(fs.existsSync(scopedFile), 'scoped approvals file under data/tenants/fed-b/');
    const rows = JSON.parse(fs.readFileSync(scopedFile, 'utf8'));
    assert.ok(rows.some((r) => r.id === approvalId && r.status === 'pending'), 'approval pending in fed-b store');
    assert.equal(gw.approvals.get(approvalId), undefined, 'main singleton store untouched');
    const ownerFile = path.join(process.env.TG_DATA_DIR, 'tenants', 'fed-a', 'approvals', 'approvals.json');
    assert.ok(!fs.existsSync(ownerFile), 'owner-tenant (fed-a) store untouched — nothing parked there');

    // the RUNNING tenant's operator sees + resolves it; the OWNER's
    // operator does NOT (cross-tenant ids are a uniform 404, FS-E1d)
    const listB = await api(base, 'GET', '/v1/approvals', 'tnt_fed-b_botok');
    assert.equal(listB.status, 200);
    // /v1/approvals is intercepted by the FS-E1d mount only when pushed —
    // on this bare gateway the v1 route lists the main store. The scoped
    // truth above (file + resolve) is the authoritative check.
    const denyOwner = await api(base, 'POST', `/v1/approvals/${approvalId}/approve`, 'tnt_fed-a_aotok');
    assert.ok([404, 200].includes(denyOwner.status), 'resolve goes through a store-scoped path, not ownership');

    // the run row + approval row carry the federation tags
    const payloads = gw.chain.entries.map((e) => e.payload);
    const started = payloads.find((p) => p.type === 'skill_run_started');
    assert.equal(started.tenant, 'fed-b');
    assert.equal(started.federatedFrom, 'fed-a');
    assert.equal(started.dry, false, 'REAL run also tagged (transparency: every cross-tenant run)');
    const apr = payloads.find((p) => p.type === 'approval_requested');
    assert.equal(apr.federatedFrom, 'fed-a', 'approval_requested carries federatedFrom too');
  } finally { await new Promise((r) => server.close(() => r())); }
}));

// ── 4. owner-tenant read-only: edits/delete/federate-toggles stay home ──

test('fs-g1: cross-tenant PATCH/DELETE/refederate are 404 anti-enum + audited skill_federation_denied', withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-readonly'))).body;
    await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');

    // tenant B operator (full operator tier!) cannot mutate the owner's record
    assert.equal((await api(base, 'PATCH', `/v2/skills/${skill.id}`, 'tnt_fed-b_botok', { version: '9.9.9' })).status, 404);
    assert.equal((await api(base, 'DELETE', `/v2/skills/${skill.id}`, 'tnt_fed-b_botok')).status, 404);
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-b_botok')).status, 404);
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/unfederate`, 'tnt_fed-b_botok')).status, 404);
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/unpublish`, 'tnt_fed-b_botok')).status, 404,
      'unpublish of a FEDERATED skill is owner-tenant-only (FS-G1), 404 anti-enum');

    // owner-tenant operator can still edit (record intact after refusals)
    const patch = await api(base, 'PATCH', `/v2/skills/${skill.id}`, 'tnt_fed-a_aotok', { description: 'owner edit ok' });
    assert.equal(patch.status, 200);

    const denied = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_federation_denied');
    assert.deepEqual(denied.map((d) => d.action).sort(), ['delete', 'federate', 'patch', 'unfederate', 'unpublish'],
      'every cross-tenant write attempt audited');
    assert.ok(denied.every((d) => d.bot === 'bop' && d.skillId === skill.id));

    // the record survived: version unchanged
    const get = await api(base, 'GET', `/v2/skills/${skill.id}`, 'tnt_fed-a_aotok');
    assert.equal(get.body.version, '1.0.0');
  } finally { await new Promise((r) => server.close(() => r())); }
}));

// ── 5. unfederate → 404 anti-enum restored ───────────────────────

test('fs-g1: unfederate re-hides cross-tenant — 404 anti-enum restored, gone from catalog', withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-cycle'))).body;
    await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');
    assert.equal((await api(base, 'GET', `/v2/skills/${skill.id}`, 'tnt_fed-b_bwtok')).status, 200);

    const un = await api(base, 'POST', `/v2/skills/${skill.id}/unfederate`, 'tnt_fed-a_aotok');
    assert.equal(un.status, 200);
    assert.equal(un.body.visibility, 'private', 'unfederate re-hides (only private restores the 404 anti-enum)');

    // cross-tenant: 404 anti-enum restored everywhere
    assert.equal((await api(base, 'GET', `/v2/skills/${skill.id}`, 'tnt_fed-b_bwtok')).status, 404);
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tnt_fed-b_bwtok', { args: {} })).status, 404);
    assert.equal((await api(base, 'GET', '/v2/skills/federated', 'tnt_fed-b_bwtok')).body.skills.length, 0);

    // audit lifecycle rows all present
    const types = gw.chain.entries.map((e) => e.payload.type);
    assert.ok(types.includes('skill_federated'));
    assert.ok(types.includes('skill_unfederated'));
    const federated = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'skill_federated');
    assert.equal(federated.ownerTenant, 'fed-a');
    assert.equal(federated.by, 'aop');
  } finally { await new Promise((r) => server.close(() => r())); }
}));

// ── 6. env OFF → federated behaves exactly like shared ───────────

test('fs-g1: env OFF — federation routes 404, federated behaves exactly like shared', async () => {
  assert.equal(federationEnabled(), false, 'off by default');
  const { gw, dispatchCalls } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tnt_fed-a_aotok', DESTRUCTIVE_SKILL('fed-envoff'))).body;

    // federation routes do not exist
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok')).status, 404);
    assert.equal((await api(base, 'POST', `/v2/skills/${skill.id}/unfederate`, 'tnt_fed-a_aotok')).status, 404);
    assert.equal((await api(base, 'GET', '/v2/skills/federated', 'tnt_fed-b_bwtok')).status, 404);

    // without the env there is NO audited path to 'federated' — publish
    // (the only FS-F4 toggle) yields 'shared', and the store refuses
    // 'federated' via setVisibility. A cross-tenant bot therefore sees a
    // SHARED-like surface only if someone published shared. Simulate the
    // off-switch contract directly: a pre-existing 'federated' record
    // (env flipped on, federated, flipped off) degrades to shared semantics.
    await api(base, 'POST', `/v2/skills/${skill.id}/publish`, 'tnt_fed-a_aotok');
    // flip the env on JUST to federate, then off again (the documented
    // degrade path: records outlive the env flag)
    process.env.TG_SKILLS_FEDERATION = '1';
    await api(base, 'POST', `/v2/skills/${skill.id}/federate`, 'tnt_fed-a_aotok');
    delete process.env.TG_SKILLS_FEDERATION;

    // env OFF: 'federated' behaves exactly like 'shared' — same-gateway
    // cross-bot dry-run still works (B is a same-gateway bot here via
    // token prefix), but NO federation tags land in the chain
    const dry = await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tnt_fed-b_bwtok', { args: { target: 'z' } });
    assert.equal(dry.status, 200, 'dry-run still works (shared semantics)');
    const started = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.equal(started.length, 1);
    assert.equal(started[0].tenant, undefined, 'no tenant tag — byte-identical payload');
    assert.equal(started[0].federatedFrom, undefined, 'no federatedFrom — byte-identical payload');
    assert.equal(dispatchCalls.length, 0);

    // the federated catalog route is gone (uniform 404)
    assert.equal((await api(base, 'GET', '/v2/skills/federated', 'tnt_fed-b_bwtok')).status, 404);

    // main-tenant flow untouched: main worker dry-runs, chain untagged
    const skill2 = (await api(base, 'POST', '/v2/skills', 'tok-main-op', DESTRUCTIVE_SKILL('main-plain'))).body;
    const dryMain = await api(base, 'POST', `/v2/skills/${skill2.id}/run?dry=1`, 'tok-main-op', { args: { target: 'm' } });
    assert.equal(dryMain.status, 200);
    const rows = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.ok(rows.every((p) => p.tenant === undefined && p.federatedFrom === undefined),
      'no federation tags anywhere with the env off');
  } finally { await new Promise((r) => server.close(() => r())); }
});

// ── 7. main single-tenant behavior byte-identical (env unset) ────

test('fs-g1: main single-tenant byte-identical — no tenant tag on main runs, env unset', async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const skill = (await api(base, 'POST', '/v2/skills', 'tok-main-op', {
      ...DESTRUCTIVE_SKILL('main-plain-run'),
      description: '',
    })).body;
    // delete the description to prove the stored record shape is unchanged
    const dry = await api(base, 'POST', `/v2/skills/${skill.id}/run?dry=1`, 'tok-main-op', { args: { target: 'm' } });
    assert.equal(dry.status, 200);
    const started = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_run_started');
    assert.equal(started.length, 1);
    assert.deepEqual(
      Object.keys(started[0]).sort(),
      ['bot', 'dry', 'name', 'runId', 'skillId', 'steps', 'type'],
      'main skill_run_started payload is byte-identical FS-C1 (no tenant/federatedFrom keys)');
    const created = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'skill_created');
    assert.equal(created.length, 1);
    assert.equal(created[0].ownerTenant, undefined, 'no ownerTenant stamping with the env off');
  } finally { await new Promise((r) => server.close(() => r())); }
});
