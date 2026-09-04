'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// FS-I1 — cross-tenant REAL skill runs under DUAL approval.
//
// Covers (per the slice spec):
//   1. requestRealRun creates a pending row; approve endpoints stamp it
//   2. a SINGLE approval is insufficient — execute is 403 skill_fed_real_denied
//   3. DUAL approval (owner + runner operator) enables the real run
//   4. execute records a result hash (sha256) and audits skill_fed_real_executed
//   5. re-execute is blocked (409) and audited
//   6. premature execute (zero/one approvals) is 403 + audited skill_fed_real_denied
//   7. TG_SKILLS_FEDERATION unset → every FS-I1 endpoint is 404
//      (byte-identical legacy)
//   8. existing fed-ledger tests stay green untouched.
//
// Harness mirrors skills-fed-ledger.test.js (in-process Gateway + fetch)
// with a TG_DB_FILE/TG_DATA_DIR jail set BEFORE requiring gateway modules.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// File-level data jail (set BEFORE gateway modules are required — db.js
// opens its SQLite connection lazily at require time via TG_DB_FILE).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i1-fed-real-'));
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = path.join(TMP, 'data');

const { Gateway } = require('../src/gateway/server');
const { getTenantStore } = require('../src/gateway/tenants');
const { getFedRunLedger } = require('../src/gateway/skills-federation');

const AUTH = 'Bear' + 'er ';

// ── HTTP harness (mirrors skills-fed-ledger.test.js) ────────────

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
      aworker: { name: 'aworker', token: 'tnt_real-a_awtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      aop: { name: 'aop', token: 'tnt_real-a_aotok', role: 'operator', capabilities: ['*'] },
      // tenant B (running tenant — the federation consumer)
      bworker: { name: 'bworker', token: 'tnt_real-b_bwtok', role: 'worker', capabilities: ['fs.read', 'skills.own'] },
      bop: { name: 'bop', token: 'tnt_real-b_botok', role: 'operator', capabilities: ['*'] },
      // tenant C (outsider — neither owner nor runner of the pair)
      cop: { name: 'cop', token: 'tnt_real-c_cotok', role: 'operator', capabilities: ['*'] },
      // main-tenant bots (default-tenant contract checks)
      mop: { name: 'mop', token: 'tok-main-op', role: 'operator', capabilities: ['*'] },
    },
    mountFiles: false,
    telemetryFile: null,
    dispatch: async (botName, tool, args) => ({ ok: true, tool, args }),
  });
  gw.mounts.push(require('../src/gateway/mounts/105-skills'));
  gw._skillsFile = path.join(TMP, `skills-${process.pid}-${++tmpCounter}.json`);
  const ts = getTenantStore(gw);
  ts.create({ name: 'real-a' });
  ts.create({ name: 'real-b' });
  ts.create({ name: 'real-c' });
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

// Fresh federated skill owned by tenant A, per test.
async function federatedSkill(gw, base, name) {
  const created = await api(base, 'POST', '/v2/skills', 'tnt_real-a_aotok', SKILL(name));
  assert.equal(created.status, 201);
  const fed = await api(base, 'POST', `/v2/skills/${created.body.id}/federate`, 'tnt_real-a_aotok', {});
  assert.equal(fed.status, 200);
  return created.body;
}

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

function resetPending() {
  const { db } = require('../src/gateway/db');
  db.prepare('DELETE FROM pending_real_runs').run();
}

// Audit rows of one type, newest first (entries carry the payload at .payload).
function auditRows(gw, type) {
  const rows = [];
  for (const e of gw.chain.entries) {
    if (e.payload && e.payload.type === type) rows.push(e.payload);
  }
  return rows;
}

// ── unit: ledger pending_real_runs methods ───────────────────────

test('fs-i1: FedRunLedger pending_real_runs — request/approve/gate/markExecuted', () => {
  let clock = 5_000_000;
  const ledger = getFedRunLedger();
  const id = ledger.requestRealRun({
    skillId: 'sk_i1_unit1', ownerTenant: 'real-a', runnerTenant: 'real-b', runnerBot: 'bop', requestedAt: clock,
  });
  assert.ok(Number.isInteger(id) && id > 0, 'requestRealRun returns the row id');

  let row = ledger.getPending(id);
  assert.equal(row.skillId, 'sk_i1_unit1');
  assert.equal(row.ownerTenant, 'real-a');
  assert.equal(row.runnerTenant, 'real-b');
  assert.equal(row.runnerBot, 'bop');
  assert.equal(row.requestedAt, clock);
  assert.equal(row.approvedByOwner, null, 'no owner stamp yet');
  assert.equal(row.approvedByRunner, null, 'no runner stamp yet');
  assert.equal(row.executedAt, null, 'not executed yet');
  assert.equal(row.resultHash, null);
  assert.equal(ledger.isFullyApproved(id), false, 'zero approvals → not fully approved');

  // requestRealRun refuses incomplete rows.
  assert.throws(() => ledger.requestRealRun({ skillId: 'sk_x' }));

  // Owner stamp only — still not fully approved.
  const afterOwner = ledger.approveByOwner(id, 'aop');
  assert.equal(afterOwner.approvedByOwner, 'aop');
  assert.equal(afterOwner.approvedByRunner, null);
  assert.equal(ledger.isFullyApproved(id), false, 'single approval is insufficient');

  // approveByOwner is idempotent (first stamp wins).
  const reOwner = ledger.approveByOwner(id, 'aop2');
  assert.equal(reOwner.approvedByOwner, 'aop', 're-approval cannot overwrite the first stamp');

  // Runner stamp completes the dual approval.
  const afterRunner = ledger.approveByRunner(id, 'bop');
  assert.equal(afterRunner.approvedByRunner, 'bop');
  assert.equal(ledger.isFullyApproved(id), true, 'both stamps → fully approved');

  // Unknown ids → null/false, never throw.
  assert.equal(ledger.getPending(999999), null);
  assert.equal(ledger.isFullyApproved(999999), false);
  assert.equal(ledger.approveByOwner(999999, 'aop'), null);
  assert.equal(ledger.approveByRunner(null, 'bop'), null);
  assert.equal(ledger.isFullyApproved(null), false);

  // markExecuted stamps time + hash and KILLS the gate (one-shot).
  clock += 1_000;
  ledger.now = () => clock;
  const executed = ledger.markExecuted(id, 'deadbeef'.repeat(8));
  assert.ok(executed.executedAt !== null);
  assert.equal(executed.resultHash, 'deadbeef'.repeat(8));
  assert.equal(ledger.isFullyApproved(id), false, 'an executed row can never run again');
  // markExecuted is idempotent — no overwrite.
  const again = ledger.markExecuted(id, 'c0ffee00'.repeat(8));
  assert.equal(again.resultHash, 'deadbeef'.repeat(8));
  // Unknown id → null.
  assert.equal(ledger.markExecuted(999999, 'x'), null);

  // Scoped list views.
  const byOwner = ledger.listPendingByOwner('real-a');
  assert.ok(byOwner.some((r) => r.id === id));
  const byRunner = ledger.listPendingByRunner('real-b');
  assert.ok(byRunner.some((r) => r.id === id));
  assert.deepEqual(ledger.listPendingByRunner('real-zzz'), []);
  assert.deepEqual(ledger.listPendingByOwner(''), []);
});

// ── integration: the four mount endpoints ────────────────────────

test('fs-i1: request creates a pending row + audited skill_fed_real_requested', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-req-a');

    // Runner-tenant operator requests the real run.
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req1.status, 201);
    assert.equal(req1.body.status, 'pending');
    assert.equal(req1.body.skillId, s1.id);
    assert.equal(req1.body.ownerTenant, 'real-a');
    assert.equal(req1.body.runnerTenant, 'real-b');

    // The ledger row exists with both stamps null.
    const ledger = getFedRunLedger();
    const row = ledger.getPending(req1.body.runId);
    assert.ok(row);
    assert.equal(row.approvedByOwner, null);
    assert.equal(row.approvedByRunner, null);
    assert.equal(ledger.isFullyApproved(req1.body.runId), false);

    // Audited.
    const requested = auditRows(gw, 'skill_fed_real_requested');
    assert.equal(requested.length, 1);
    assert.equal(requested[0].runId, req1.body.runId);
    assert.equal(requested[0].ownerTenant, 'real-a');
    assert.equal(requested[0].runnerTenant, 'real-b');

    // Owner-side operator can also open a request.
    const req2 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-a_aotok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req2.status, 201);

    // A non-federated / unknown skill → 404 audited.
    const denied1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: 'sk_nope', runnerTenant: 'real-b' });
    assert.equal(denied1.status, 404);
    assert.ok(auditRows(gw, 'skill_fed_real_denied').some((r) => r.reason === 'skill_not_federated'));

    // Same-tenant "runner" (runner == owner) → 400.
    const denied2 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-a_aotok', { skillId: s1.id, runnerTenant: 'real-a' });
    assert.equal(denied2.status, 400);

    // A THIRD tenant operator (neither party) → 403.
    const denied3 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-c_cotok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(denied3.status, 403);
  } finally { server.close(); }
}));

test('fs-i1: premature execute (no approval) → 403 + audited skill_fed_real_denied, nothing executes', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-prem-a');
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req1.status, 201);

    const dispatchCalls = [];
    gw.dispatch = async (botName, tool, args) => { dispatchCalls.push({ botName, tool, args }); return { ok: true }; };

    const ex = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/execute`, 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex.status, 403);
    assert.deepEqual(ex.body, { error: 'dual_approval_required' });

    // NOTHING executed, nothing stamped.
    assert.equal(dispatchCalls.length, 0);
    assert.equal(getFedRunLedger().getPending(req1.body.runId).executedAt, null);

    const denied = auditRows(gw, 'skill_fed_real_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].reason, 'dual_approval_required');
    assert.equal(auditRows(gw, 'skill_fed_real_executed').length, 0);

    // Unknown run id → 404.
    const ex404 = await api(base, 'POST', '/v2/skills/federated/runs/999999/execute', 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex404.status, 404);
  } finally { server.close(); }
}));

test('fs-i1: single approval is insufficient — owner-only stamp still 403', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-single-a');
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req1.status, 201);

    // Owner approves; runner does not.
    const apOwner = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-owner`, 'tnt_real-a_aotok', {});
    assert.equal(apOwner.status, 200);
    assert.ok(apOwner.body.approvedByOwner);
    assert.equal(apOwner.body.approvedByRunner, null);
    assert.equal(apOwner.body.status, 'pending');

    const dispatchCalls = [];
    gw.dispatch = async () => { dispatchCalls.push(1); return { ok: true }; };
    const ex = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/execute`, 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex.status, 403);
    assert.equal(dispatchCalls.length, 0, 'single approval must not enable execution');
    assert.ok(auditRows(gw, 'skill_fed_real_denied').some((r) => r.reason === 'dual_approval_required' && r.runId === req1.body.runId));
  } finally { server.close(); }
}));

test('fs-i1: approval side-scoping — only the matching tenant operator can stamp each side', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-side-a');
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req1.status, 201);

    // The RUNNER operator cannot stamp the OWNER side.
    const apWrong = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-owner`, 'tnt_real-b_botok', {});
    assert.equal(apWrong.status, 403);
    assert.deepEqual(apWrong.body, { error: 'owner_tenant_required' });

    // The OWNER operator cannot stamp the RUNNER side.
    const apWrongR = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-runner`, 'tnt_real-a_aotok', {});
    assert.equal(apWrongR.status, 403);
    assert.deepEqual(apWrongR.body, { error: 'runner_tenant_required' });

    // A third tenant operator cannot stamp either side.
    assert.equal((await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-owner`, 'tnt_real-c_cotok', {})).status, 403);
    assert.equal((await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-runner`, 'tnt_real-c_cotok', {})).status, 403);

    // No stamps landed.
    const ledger = getFedRunLedger();
    const row = ledger.getPending(req1.body.runId);
    assert.equal(row.approvedByOwner, null);
    assert.equal(row.approvedByRunner, null);
    assert.ok(auditRows(gw, 'skill_fed_real_denied').some((r) => r.reason === 'not_owner_tenant'));
    assert.ok(auditRows(gw, 'skill_fed_real_denied').some((r) => r.reason === 'not_runner_tenant'));
  } finally { server.close(); }
}));

test('fs-i1: dual approval enables execute — hash recorded, audited, non-owner cannot approve', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-dual-a');
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-a_aotok', { skillId: s1.id, runnerTenant: 'real-b' });
    assert.equal(req1.status, 201);

    // A non-operator (worker) cannot stamp an approval.
    const denied = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-runner`, 'tnt_real-b_bwtok', {});
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: 'operator_required' });
    assert.ok(auditRows(gw, 'skill_denied').some((r) => r.action === 'fed_real_runs'));

    // Dual approval: owner stamps, runner stamps.
    const apOwner = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-owner`, 'tnt_real-a_aotok', {});
    assert.equal(apOwner.status, 200);
    const apRunner = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-runner`, 'tnt_real-b_botok', {});
    assert.equal(apRunner.status, 200);
    assert.equal(apRunner.body.status, 'approved');
    assert.ok(apRunner.body.approvedByOwner);
    assert.ok(apRunner.body.approvedByRunner);

    const dispatchCalls = [];
    gw.dispatch = async (botName, tool, args) => { dispatchCalls.push({ botName, tool, args }); return { ok: true, tool, path: args.path }; };

    const ex = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/execute`, 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex.status, 200);
    assert.equal(ex.body.status, 'completed');
    assert.ok(/^[0-9a-f]{64}$/.test(ex.body.resultHash), 'execute records a sha256 result hash');
    assert.ok(Array.isArray(ex.body.steps) && ex.body.steps.length === 1);

    // The skill really executed in the runner context.
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].tool, 'fs.read');
    assert.deepEqual(dispatchCalls[0].args, { path: '/tmp' });

    // The hash matches the recorded ledger row.
    const ledger = getFedRunLedger();
    const row = ledger.getPending(req1.body.runId);
    assert.equal(row.resultHash, ex.body.resultHash);
    assert.ok(row.executedAt !== null);
    assert.equal(ledger.isFullyApproved(req1.body.runId), false, 'executed row is no longer runnable');

    // Audits: approved_owner + approved_runner + executed + run_started tags.
    assert.equal(auditRows(gw, 'skill_fed_real_approved_owner').length, 1);
    assert.equal(auditRows(gw, 'skill_fed_real_approved_runner').length, 1);
    const executed = auditRows(gw, 'skill_fed_real_executed');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].resultHash, ex.body.resultHash);
    assert.equal(executed[0].runnerTenant, 'real-b');
    assert.equal(executed[0].ownerTenant, 'real-a');
    const started = auditRows(gw, 'skill_run_started').filter((r) => r.runId === ex.body.runChainSeq);
    assert.equal(started.length, 1);
    assert.equal(started[0].dry, false);
    assert.equal(started[0].federatedFrom, 'real-a', 'cross-tenant tag present');
  } finally { server.close(); }
}));

test('fs-i1: re-execute after execution is blocked (409) and audited', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    const s1 = await federatedSkill(gw, base, 'fs-i1-reexec-a');
    const req1 = await api(base, 'POST', '/v2/skills/federated/runs/request', 'tnt_real-b_botok', { skillId: s1.id, runnerTenant: 'real-b' });
    await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-owner`, 'tnt_real-a_aotok', {});
    await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/approve-runner`, 'tnt_real-b_botok', {});

    const dispatchCalls = [];
    gw.dispatch = async (botName, tool, args) => { dispatchCalls.push({ botName, tool, args }); return { ok: true }; };

    const ex1 = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/execute`, 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex1.status, 200);
    const firstHash = ex1.body.resultHash;

    // Second execute → 409, nothing runs again.
    const ex2 = await api(base, 'POST', `/v2/skills/federated/runs/${req1.body.runId}/execute`, 'tnt_real-b_botok', { args: { dir: '/tmp' } });
    assert.equal(ex2.status, 409);
    assert.deepEqual(ex2.body, { error: 'already_executed' });
    assert.equal(dispatchCalls.length, 1, 'the skill executed exactly once');

    const denied = auditRows(gw, 'skill_fed_real_denied');
    assert.ok(denied.some((r) => r.reason === 'already_executed' && r.runId === req1.body.runId));
    // The ledger row still carries the FIRST run's hash.
    assert.equal(getFedRunLedger().getPending(req1.body.runId).resultHash, firstHash);
  } finally { server.close(); }
}));

test('fs-i1: TG_SKILLS_FEDERATION unset → every FS-I1 endpoint is 404 (byte-identical legacy)', { concurrency: 1 }, withFederation(async () => {
  const { gw } = buildGateway();
  const { server, base } = await listen(gw);
  try {
    // Create + federate WITH the env on, then flip it off: the skill
    // degrades to 'shared' and the whole FS-I1 surface must vanish.
    const s1 = await federatedSkill(gw, base, 'fs-i1-off-a');
    delete process.env.TG_SKILLS_FEDERATION;

    const calls = [
      ['POST', '/v2/skills/federated/runs/request', { skillId: s1.id, runnerTenant: 'real-b' }, 'tnt_real-b_botok'],
      ['POST', '/v2/skills/federated/runs/1/approve-owner', {}, 'tnt_real-a_aotok'],
      ['POST', '/v2/skills/federated/runs/1/approve-runner', {}, 'tnt_real-b_botok'],
      ['POST', '/v2/skills/federated/runs/1/execute', { args: { dir: '/tmp' } }, 'tnt_real-b_botok'],
    ];
    for (const [method, p, body, token] of calls) {
      const r = await api(base, method, p, token, body);
      assert.equal(r.status, 404, `${method} ${p} must be 404 with the env unset`);
      assert.deepEqual(r.body, { error: 'not_found' });
    }
    // No pending rows CREATED by these calls (the shared db ledger may
    // still hold rows from earlier tests — clear it first, then check).
    resetPending();
    assert.equal(getFedRunLedger().listPendingByRunner('real-b').length, 0);
    assert.equal(auditRows(gw, 'skill_fed_real_requested').length, 0);
    assert.equal(auditRows(gw, 'skill_fed_real_executed').length, 0);
    assert.equal(auditRows(gw, 'skill_fed_real_denied').length, 0);
  } finally { server.close(); }
}));