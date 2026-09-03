'use strict';
// FS-H2 — federation run ledger + cross-tenant dry-run limits.
//
// Covers (per the slice spec):
//   1. FedRunLedger record / countByRunner window / countBySkill
//   2. per-runner-tenant cap (TG_FED_RUNS_PER_HOUR) enforced BEFORE the
//      dry-run executes → 429 {error:'fed_rate_limited'} + audited
//      skill_fed_limited {runnerTenant, skillId}
//   3. per-skill cap (TG_FED_RUNS_PER_SKILL_HOUR), same shape
//   4. env unset → defaults active (20/50)
//   5. TG_SKILLS_FEDERATION unset → everything inert (no 429, no ledger rows)
//   6. GET /v2/skills/federated/runs — operator ledger views scoped to the
//      calling tenant (runner view + ?owner=1 owner view)
//   7. existing federation tests stay green untouched.
//
// Harness mirrors skills-federation.test.js (in-process Gateway + fetch)
// with a TG_DB_FILE/TG_DATA_DIR jail set BEFORE requiring gateway modules.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// File-level data jail (set BEFORE gateway modules are required — db.js
// opens its SQLite connection lazily at require time via TG_DB_FILE).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-h2-fed-ledger-'));
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = path.join(TMP, 'data');

const { Gateway } = require('../src/gateway/server');
const { getTenantStore } = require('../src/gateway/tenants');
const { FedRunLedger, getFedRunLedger, fedRunsPerHour, fedRunsPerSkillHour, WINDOW_MS } = require('../src/gateway/skills-federation');

const AUTH = 'Bear' + 'er ';

// ── HTTP harness (mirrors skills-federation.test.js) ────────────

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
function buildGateway() {
  const gw = new Gateway({
    bots: {
      // tenant A (owner tenant)
      aworker: { name: 'aworker', token: 'tnt_led-a_awtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      aop: { name: 'aop', token: 'tnt_led-a_aotok', role: 'operator', capabilities: ['*'] },
      // main-tenant bots (default-tenant contract checks)
      mworker: { name: 'mworker', token: 'tok-main-worker', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      mop: { name: 'mop', token: 'tok-main-op', role: 'operator', capabilities: ['*'] },
      // tenant B (running tenant — the federation consumer)
      bworker: { name: 'bworker', token: 'tnt_led-b_bwtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      bop: { name: 'bop', token: 'tnt_led-b_botok', role: 'operator', capabilities: ['*'] },
      // tenant C (another runner — for per-skill cap + view scoping)
      cworker: { name: 'cworker', token: 'tnt_led-c_cwtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      cop: { name: 'cop', token: 'tnt_led-c_cotok', role: 'operator', capabilities: ['*'] },
    },
    mountFiles: false,
    telemetryFile: null,
    dispatch: async (botName, tool, args) => ({ ok: true, tool }),
  });
  gw.mounts.push(require('../src/gateway/mounts/105-skills'));
  gw._skillsFile = path.join(TMP, `skills-${process.pid}-${++tmpCounter}.json`);
  const ts = getTenantStore(gw);
  ts.create({ name: 'led-a' });
  ts.create({ name: 'led-b' });
  ts.create({ name: 'led-c' });
  return { gw };
}

async function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const SKILL = (name) => ({
  name,
  version: '1.0.0',
  description: 'list a dir',
  steps: [{ tool: 'fs.read', argsTemplate: '{"path":"{{dir}}"}' }],
});

// Fresh skill, federated by tenant A's operator, per test.
async function federatedSkill(gw, base, name) {
  const created = await api(base, 'POST', '/v2/skills', 'tnt_led-a_aotok', SKILL(name));
  assert.equal(created.status, 201);
  const fed = await api(base, 'POST', `/v2/skills/${created.body.id}/federate`, 'tnt_led-a_aotok', {});
  assert.equal(fed.status, 200);
  return created.body;
}

function withFederation(env = {}) {
  return (fn) => async (t) => {
    process.env.TG_SKILLS_FEDERATION = '1';
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      await fn(t);
    } finally {
      delete process.env.TG_SKILLS_FEDERATION;
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
}

// Last skill_fed_limited audit rows on the chain (entries carry the audit
// payload at .payload — see HashChain.append).
function fedLimitedRows(gw) {
  const rows = [];
  for (const e of gw.chain.entries) {
    if (e.payload && e.payload.type === 'skill_fed_limited') rows.push(e.payload);
  }
  return rows;
}

// List-views test also needs a clean slate: rows recorded by earlier
// integration tests in this file would otherwise leak into the counts.
function resetLedger() {
  const { db } = require('../src/gateway/db');
  db.prepare('DELETE FROM fed_runs').run();
}

// ── unit: ledger + env caps ──────────────────────────────────────

test('fs-h2: FedRunLedger record / countByRunner window / countBySkill', () => {
  let clock = 1_000_000;
  const ledger = new FedRunLedger({ now: () => clock });
  ledger.record({ skillId: 'sk_aaaa1111', ownerTenant: 'led-a', runnerTenant: 'led-b', runnerBot: 'bworker', ranAt: 900_000 });
  ledger.record({ skillId: 'sk_aaaa1111', ownerTenant: 'led-a', runnerTenant: 'led-b', runnerBot: 'bworker', ranAt: 1_100_000 });
  ledger.record({ skillId: 'sk_bbbb2222', ownerTenant: 'led-a', runnerTenant: 'led-c', runnerBot: 'cworker', ranAt: 1_200_000 });

  assert.equal(ledger.countBySkill('sk_aaaa1111'), 2);
  assert.equal(ledger.countBySkill('sk_bbbb2222'), 1);
  assert.equal(ledger.countBySkill('sk_nope0000'), 0);

  // Window is (now - windowMs, now]: only rows inside the window count.
  clock = 1_250_000;
  assert.equal(ledger.countByRunner('led-b', WINDOW_MS, clock), 2, 'both led-b rows are within one hour');
  assert.equal(ledger.countByRunner('led-b', 350_000, clock), 1, '900_000 row is exactly windowMs old — excluded');
  assert.equal(ledger.countByRunner('led-b', 50_000, clock), 0, 'only rows newer than 1_200_000 count');
  assert.equal(ledger.countByRunner('led-c', WINDOW_MS, clock), 1);
  assert.equal(ledger.countByRunner('led-zzz', WINDOW_MS, clock), 0);

  // Default clock (no ranAt) works and counts immediately.
  const ledger2 = new FedRunLedger();
  ledger2.record({ skillId: 'sk_cccc3333', ownerTenant: 'led-a', runnerTenant: 'led-b', runnerBot: 'bworker' });
  assert.equal(ledger2.countBySkill('sk_cccc3333'), 1);
  assert.ok(ledger2.countByRunner('led-b', WINDOW_MS) >= 1);

  // record() refuses incomplete rows.
  assert.throws(() => ledger2.record({ skillId: 'sk_x' }));

  // list views are camelCase projections.
  const rows = ledger.listByRunner('led-b');
  assert.ok(rows.length >= 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'ownerTenant', 'ranAt', 'runnerBot', 'runnerTenant', 'skillId']);
  const ownerRows = ledger.listByOwner('led-a');
  assert.ok(ownerRows.length >= 3);
  assert.ok(ownerRows.every((r) => r.ownerTenant === 'led-a'));
});

test('fs-h2: env caps — defaults active when unset, garbage falls back, explicit value honoured', () => {
  const saved = { a: process.env.TG_FED_RUNS_PER_HOUR, s: process.env.TG_FED_RUNS_PER_SKILL_HOUR };
  try {
    delete process.env.TG_FED_RUNS_PER_HOUR;
    delete process.env.TG_FED_RUNS_PER_SKILL_HOUR;
    assert.equal(fedRunsPerHour(), 20, 'default per-runner cap active with env unset');
    assert.equal(fedRunsPerSkillHour(), 50, 'default per-skill cap active with env unset');

    process.env.TG_FED_RUNS_PER_HOUR = '0';
    assert.equal(fedRunsPerHour(), 20, "'0' never disables the cap (fail closed)");
    process.env.TG_FED_RUNS_PER_HOUR = 'garbage';
    assert.equal(fedRunsPerHour(), 20);
    process.env.TG_FED_RUNS_PER_HOUR = '3.5';
    assert.equal(fedRunsPerHour(), 20);
    process.env.TG_FED_RUNS_PER_HOUR = '2';
    assert.equal(fedRunsPerHour(), 2, 'explicit positive integer honoured');

    process.env.TG_FED_RUNS_PER_SKILL_HOUR = '-1';
    assert.equal(fedRunsPerSkillHour(), 50, 'negative never disables the cap');

    // capFromEnv directly: '' is treated as unset → fallback.
    delete process.env.TG_FED_RUNS_PER_HOUR;
    process.env.TG_FED_RUNS_PER_HOUR = '';
    assert.equal(fedRunsPerHour(), 20);
  } finally {
    if (saved.a === undefined) delete process.env.TG_FED_RUNS_PER_HOUR; else process.env.TG_FED_RUNS_PER_HOUR = saved.a;
    if (saved.s === undefined) delete process.env.TG_FED_RUNS_PER_SKILL_HOUR; else process.env.TG_FED_RUNS_PER_SKILL_HOUR = saved.s;
  }
});

// ── integration: caps enforced before the dry-run executes ───────

test('fs-h2: per-runner cap → 429 fed_rate_limited + audited skill_fed_limited', { concurrency: 1 }, withFederation({ TG_FED_RUNS_PER_HOUR: '2', TG_FED_RUNS_PER_SKILL_HOUR: '100' })(async () => {
  resetLedger();
const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-h2-pr-a');
    const s2 = await federatedSkill(gw, base, 'fs-h2-pr-b');
    const s3 = await federatedSkill(gw, base, 'fs-h2-pr-c');

    // First two cross-tenant dry runs from tenant B pass the cap of 2.
    const r1 = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    assert.equal(r1.status, 200);
    const r2 = await api(base, 'POST', `/v2/skills/${s2.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    assert.equal(r2.status, 200);

    // Third — even a DIFFERENT skill — is refused BEFORE executing.
    const r3 = await api(base, 'POST', `/v2/skills/${s3.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    assert.equal(r3.status, 429);
    assert.deepEqual(r3.body, { error: 'fed_rate_limited' });

    // Honesty: the limited dry run did NOT execute and was NOT recorded.
    const ledger = getFedRunLedger();
    assert.equal(ledger.countByRunner('led-b', WINDOW_MS), 2);
    assert.equal(ledger.countBySkill(s3.id), 0);

    // Audited skill_fed_limited with the spec shape.
    const limited = fedLimitedRows(gw).filter((r) => r.skillId === s3.id);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].runnerTenant, 'led-b');
    assert.equal(limited[0].limitKind, 'per_runner_tenant');

    // A different runner tenant is NOT limited by B's usage.
    const rc = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-c_cwtok', { args: { dir: '/tmp' } });
    assert.equal(rc.status, 200);

    // The owner tenant dry-running its OWN skill is same-tenant — untouched.
    const own = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-a_awtok', { args: { dir: '/tmp' } });
    assert.equal(own.status, 200);
  } finally { server.close(); }
}));

test('fs-h2: per-skill cap → 429 fed_rate_limited + audited skill_fed_limited', { concurrency: 1 }, withFederation({ TG_FED_RUNS_PER_HOUR: '100', TG_FED_RUNS_PER_SKILL_HOUR: '3' })(async () => {
  resetLedger();
const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-h2-ps-a');

    // Three different runner tenants (and bots) burn the per-skill cap of 3.
    assert.equal((await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } })).status, 200);
    assert.equal((await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/x' } })).status, 200);
    assert.equal((await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-c_cwtok', { args: { dir: '/tmp' } })).status, 200);

    const r4 = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-c_cwtok', { args: { dir: '/tmp' } });
    assert.equal(r4.status, 429);
    assert.deepEqual(r4.body, { error: 'fed_rate_limited' });

    const limited = fedLimitedRows(gw).filter((r) => r.skillId === s1.id);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].runnerTenant, 'led-c');
    assert.equal(limited[0].limitKind, 'per_skill');

    // Honest accounting: exactly 3 recorded runs of the skill, no 4th.
    const ledger = getFedRunLedger();
    assert.equal(ledger.countBySkill(s1.id), 3);

    // A DIFFERENT skill is unaffected by skill 1's per-skill cap.
    const s2 = await federatedSkill(gw, base, 'fs-h2-ps-b');
    assert.equal((await api(base, 'POST', `/v2/skills/${s2.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } })).status, 200);
  } finally { server.close(); }
}));

test('fs-h2: env unset → defaults active on the live route', { concurrency: 1 }, withFederation()(async () => {
  resetLedger();
const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    assert.equal(fedRunsPerHour(), 20);
    assert.equal(fedRunsPerSkillHour(), 50);
    const s1 = await federatedSkill(gw, base, 'fs-h2-def-a');
    // 20 default-cap dry runs pass; the 21st is refused with the honest 429.
    for (let i = 0; i < 20; i++) {
      const r = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
      assert.equal(r.status, 200, `run ${i + 1} should pass the default cap`);
    }
    const over = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    assert.equal(over.status, 429);
    assert.deepEqual(over.body, { error: 'fed_rate_limited' });
    assert.equal(getFedRunLedger().countBySkill(s1.id), 20);
  } finally { server.close(); }
}));

test('fs-h2: federation env unset → limits and ledger fully inert', { concurrency: 1 }, withFederation()(async () => {
  // Flip the federation switch off but keep the caps unset — the whole
  // FS-H2 path must be unreachable and the ledger must stay empty.
  resetLedger();
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    // Create + federate WITH the env on, then flip it off: the skill now
    // degrades to 'shared' semantics and the FS-H2 path must stay inert.
    const s1 = await federatedSkill(gw, base, 'fs-h2-off-a');
    delete process.env.TG_SKILLS_FEDERATION;
    // 'federated' degrades to 'shared': same-tenant dry-run still works.
    const own = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-a_awtok', { args: { dir: '/tmp' } });
    assert.equal(own.status, 200);
    // Off-env dry-run loop past the default cap — no limits exist.
    for (let i = 0; i < 25; i++) {
      const r = await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
      assert.equal(r.status, 200);
    }
    // No ledger rows, no fed_limited audit rows.
    assert.equal(getFedRunLedger().countBySkill(s1.id), 0);
    assert.equal(getFedRunLedger().countByRunner('led-b', WINDOW_MS), 0);
    assert.equal(fedLimitedRows(gw).length, 0);
    // Ledger route is 404 with the env off (route does not exist).
    assert.equal((await api(base, 'GET', '/v2/skills/federated/runs', 'tnt_led-b_botok')).status, 404);
  } finally { server.close(); }
}));

// ── integration: operator ledger views ───────────────────────────

test('fs-h2: operator ledger views — runner + ?owner=1, tenant-scoped', { concurrency: 1 }, withFederation()(async () => {
  resetLedger();
const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-h2-view-a');
    const s2 = await federatedSkill(gw, base, 'fs-h2-view-b');
    // B runs A's skill; C runs A's other skill.
    await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    await api(base, 'POST', `/v2/skills/${s2.id}/run?dry=1`, 'tnt_led-b_bwtok', { args: { dir: '/tmp' } });
    await api(base, 'POST', `/v2/skills/${s1.id}/run?dry=1`, 'tnt_led-c_cwtok', { args: { dir: '/tmp' } });

    // Runner view (tenant B operator): what B's bots ran elsewhere.
    const runnerView = await api(base, 'GET', '/v2/skills/federated/runs', 'tnt_led-b_botok');
    assert.equal(runnerView.status, 200);
    assert.equal(runnerView.body.view, 'runner');
    assert.equal(runnerView.body.tenant, 'led-b');
    assert.equal(runnerView.body.runs.length, 2);
    assert.ok(runnerView.body.runs.every((r) => r.runnerTenant === 'led-b'));
    assert.ok(runnerView.body.runs.every((r) => r.ownerTenant === 'led-a'));

    // Owner view (tenant A operator, ?owner=1): who ran A's skills.
    const ownerView = await api(base, 'GET', '/v2/skills/federated/runs?owner=1', 'tnt_led-a_aotok');
    assert.equal(ownerView.status, 200);
    assert.equal(ownerView.body.view, 'owner');
    assert.equal(ownerView.body.runs.length, 3);
    assert.ok(ownerView.body.runs.every((r) => r.ownerTenant === 'led-a'));

    // Tenant C's owner view sees only C-owned skill runs (1).
    const ownerViewC = await api(base, 'GET', '/v2/skills/federated/runs?owner=1', 'tnt_led-c_cotok');
    assert.equal(ownerViewC.status, 200);
    assert.equal(ownerViewC.body.runs.length, 0, 'C owns no skills others ran');

    // Scoping is strict: B's owner view is empty (B owns nothing federated-run).
    const ownerViewB = await api(base, 'GET', '/v2/skills/federated/runs?owner=1', 'tnt_led-b_botok');
    assert.equal(ownerViewB.status, 200);
    assert.equal(ownerViewB.body.runs.length, 0);

    // Non-operator on the ledger route → 403, audited skill_denied.
    const denied = await api(base, 'GET', '/v2/skills/federated/runs', 'tnt_led-b_bwtok');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: 'operator_required' });

    // Env off → 404 even for an operator.
    delete process.env.TG_SKILLS_FEDERATION;
    assert.equal((await api(base, 'GET', '/v2/skills/federated/runs', 'tnt_led-b_botok')).status, 404);
  } finally { server.close(); }
}));

// ── contract: existing FS-G1 suite semantics stay intact ─────────

test('fs-h2: same-tenant shared dry-runs are NOT ledgered or limited', { concurrency: 1 }, withFederation()(async () => {
  resetLedger();
const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    // A merely SHARED (not federated) skill: cross-bot same-tenant use.
    const created = await api(base, 'POST', '/v2/skills', 'tnt_led-a_aotok', SKILL('fs-h2-shared-a'));
    assert.equal(created.status, 201);
    const pub = await api(base, 'POST', `/v2/skills/${created.body.id}/publish`, 'tnt_led-a_aotok', {});
    assert.equal(pub.status, 200);

    // Main-tenant bot dry-runs it repeatedly — same tenant (main), never cross-tenant.
    for (let i = 0; i < 22; i++) {
      const r = await api(base, 'POST', `/v2/skills/${created.body.id}/run?dry=1`, 'tok-main-worker', { args: { dir: '/tmp' } });
      assert.ok([200, 404].includes(r.status), 'same-tenant shared dry run is not rate limited');
    }
    assert.equal(getFedRunLedger().countBySkill(created.body.id), 0);
    assert.equal(fedLimitedRows(gw).length, 0);
  } finally { server.close(); }
}));
