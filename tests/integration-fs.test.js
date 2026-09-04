'use strict';
// FS-D2 — integration battery over a REAL spawned gateway process
// (tests/fs-helpers.js: bin/gateway.js --dispatch, stub OpenAI brain,
// jailed dispatcher, isolated tmp storage). One gateway for the whole
// battery so the chain accumulates a realistic, ordered history:
//
//   healthz → chain verify → audit append → search round-trip
//   approvals full lifecycle (request → impact snapshot → approve →
//     action_executed_after_approval in chain)
//   runs lifecycle via stub-brain deep chat (start → step → end → GET /v2/runs)
//   artifacts → version → list
//   memory CRUD
//   deeplink /d/ resolution happy + miss
//
// Zero deps beyond node: builtins; mounts-only patterns; secrets never
// asserted INTO bodies — only their absence (see security-sweep.test.js).

const test = require('node:test');
const assert = require('node:assert');

const { spawnGateway, api, TOKENS, JAIL_FILE_TEXT } = require('./fs-helpers.js');

test('FS-D2 integration battery on a real gateway', { skip: process.platform === 'win32' ? 'Windows: spawned-gateway tree-kill leaves stdio handles open — hangs node --test (see STUDY-011 infra notes)' : false }, async () => {
  const g = await spawnGateway({
    // iteration 1 proposes a jail read (allow → executed), iteration 2
    // (the default plain stub reply) has no action → run completes.
    replies: ['<action tool="fs.read:notes/todo.md" />'],
  });
  try {
    const { base } = g;
    const forge = TOKENS.forge;
    const atlas = TOKENS.atlas;

    // ── 1. healthz + chain verify ────────────────────────────────────
    const hz = await api(base, 'GET', '/healthz');
    assert.strictEqual(hz.status, 200);
    assert.strictEqual(hz.json.ok, true);
    assert.strictEqual(hz.json.chain.ok, true);
    const ver = await api(base, 'GET', '/v1/audit/verify', { token: forge });
    assert.strictEqual(ver.status, 200);
    assert.strictEqual(ver.json.ok, true);

    // ── 2. audit append → search round-trip ──────────────────────────
    const read = await api(base, 'POST', '/v1/actions', {
      token: forge,
      body: { tool: 'fs.read:notes/todo.md' },
    });
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.json.decision, 'allow');
    assert.strictEqual(read.json.result.content, JAIL_FILE_TEXT); // jailed dispatcher really read the file

    const audit = await api(base, 'GET', '/v1/audit', { token: forge });
    assert.strictEqual(audit.status, 200);
    assert.strictEqual(audit.json.verified.ok, true);
    const executed = audit.json.entries.find(
      (e) => e.payload.type === 'action_executed' && e.payload.tool === 'fs.read:notes/todo.md'
    );
    assert.ok(executed, 'action_executed entry sealed in chain');
    assert.strictEqual(executed.payload.ok, true);
    // Write-ahead hygiene: the DECISION entry precedes the execution.
    const decided = audit.json.entries.find(
      (e) => e.payload.type === 'action_decision' && e.payload.tool === 'fs.read:notes/todo.md'
    );
    assert.ok(decided && decided.seq < executed.seq, 'decision audited before execution');

    const search = await api(base, 'GET', `/v2/search?q=${encodeURIComponent('fs.read:notes/todo.md')}&token=${forge}`);
    assert.strictEqual(search.status, 200);
    assert.ok(search.json.hits.length >= 1, 'search finds the sealed entry');
    assert.ok(
      search.json.hits.some((hit) => hit.payload && hit.payload.tool === 'fs.read:notes/todo.md'),
      'search round-trip returns the audited payload'
    );

    // ── 3. approvals full lifecycle ──────────────────────────────────
    const req1 = await api(base, 'POST', '/v1/actions', {
      token: forge,
      body: { tool: 'shell.run', args: { cmd: 'echo fsd2' } },
    });
    assert.strictEqual(req1.status, 202); // destructive → parked, never executed
    assert.strictEqual(req1.json.decision, 'needs_approval');
    const approvalId = req1.json.approvalId;
    assert.match(approvalId, /^apr_\d{6}$/);

    // Impact snapshot is audited (deterministic, never raw args).
    const audit2 = await api(base, 'GET', '/v1/audit', { token: forge });
    const requested = audit2.json.entries.find(
      (e) => e.payload.type === 'approval_requested' && e.payload.approvalId === approvalId
    );
    const impactSnap = audit2.json.entries.find(
      (e) => e.payload.type === 'approval_impact_snapshot' && e.payload.approvalId === approvalId
    );
    assert.ok(requested, 'approval_requested sealed');
    assert.ok(impactSnap, 'approval_impact_snapshot sealed');
    assert.ok(impactSnap.payload.risk, 'snapshot carries risk classification');

    const pending = await api(base, 'GET', '/v1/approvals', { token: atlas });
    assert.strictEqual(pending.status, 200);
    assert.ok(pending.json.pending.some((p) => p.id === approvalId), 'parked approval is pending');

    // Worker cannot approve (RBAC fail-closed)…
    const selfApprove = await api(base, 'POST', `/v1/approvals/${approvalId}/approve`, { token: forge });
    assert.strictEqual(selfApprove.status, 403);
    // …operator can, and the parked action executes AFTER approval.
    const approve = await api(base, 'POST', `/v1/approvals/${approvalId}/approve`, { token: atlas });
    assert.strictEqual(approve.status, 200);
    assert.strictEqual(approve.json.status, 'approved');

    const audit3 = await api(base, 'GET', '/v1/audit', { token: forge });
    const afterApproval = audit3.json.entries.find(
      (e) => e.payload.type === 'action_executed_after_approval' && e.payload.approvalId === approvalId
    );
    assert.ok(afterApproval, 'action_executed_after_approval sealed in chain');
    assert.strictEqual(afterApproval.payload.ok, true);

    // ── 4. runs lifecycle via stub-brain deep chat ───────────────────
    const deep = await api(base, 'POST', '/v2/chat/llm/deep', {
      token: forge,
      body: { session: 'fsd2-runs', message: 'read the jail note', bot: 'forge' },
    });
    assert.strictEqual(deep.status, 200);
    assert.strictEqual(deep.json.fallback, undefined); // brain IS configured (stub)
    assert.strictEqual(deep.json.actions.length, 1);
    assert.strictEqual(deep.json.actions[0].decision, 'allow');
    assert.strictEqual(deep.json.actions[0].tool, 'fs.read:notes/todo.md');

    const runs = await api(base, 'GET', '/v2/runs?bot=forge&state=completed', { token: forge });
    assert.strictEqual(runs.status, 200);
    const run = runs.json.runs.find((r) => r.session === 'fsd2-runs');
    assert.ok(run, 'deep-chat run listed via GET /v2/runs');
    assert.strictEqual(run.engine, 'llm-loop');
    assert.strictEqual(run.state, 'completed');
    assert.ok(run.steps.length >= 2, 'run carries plan + action steps');
    assert.strictEqual(run.steps[0].kind, 'action');
    assert.strictEqual(run.steps[0].decision, 'allow');
    assert.strictEqual(run.steps[0].tool, 'fs.read:notes/todo.md');
    assert.ok(run.steps[0].argsDigest && run.steps[0].resultDigest, 'digests recorded, never plaintext');
    assert.strictEqual(run.steps[run.steps.length - 1].kind, 'plan');

    const one = await api(base, 'GET', `/v2/runs/${run.id}`, { token: forge });
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.run.id, run.id);
    const refTypes = one.json.chainRefs.map((r) => r.type);
    assert.ok(refTypes.includes('run_started'), 'run_started provenance ref');
    assert.ok(refTypes.includes('run_completed'), 'run_completed provenance ref');

    const audit4 = await api(base, 'GET', '/v1/audit', { token: forge });
    assert.ok(audit4.json.entries.some((e) => e.payload.type === 'run_started' && e.payload.runId === run.id));
    assert.ok(audit4.json.entries.some((e) => e.payload.type === 'run_completed' && e.payload.runId === run.id));

    // ── 5. artifacts → version → list ────────────────────────────────
    const created = await api(base, 'POST', '/v2/artifacts', {
      token: forge,
      body: { kind: 'code', title: 'FS-D2 integration artifact', content: 'console.log("v1")' },
    });
    assert.strictEqual(created.status, 201);
    const artId = created.json.artifact.id;
    assert.match(artId, /^art_/);
    assert.strictEqual(created.json.artifact.versions.length, 1);

    const updated = await api(base, 'PUT', `/v2/artifacts/${artId}`, {
      token: forge,
      body: { content: 'console.log("v2")' },
    });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.json.version.v, 2);
    assert.strictEqual(updated.json.artifact.versions.length, 2);

    const got = await api(base, 'GET', `/v2/artifacts/${artId}`, { token: forge });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.json.artifact.title, 'FS-D2 integration artifact');
    assert.strictEqual(got.json.artifact.versions.length, 2);

    const list = await api(base, 'GET', '/v2/artifacts?kind=code', { token: forge });
    assert.strictEqual(list.status, 200);
    assert.ok(list.json.artifacts.some((a) => a.id === artId), 'artifact appears in list');

    // ── 6. memory CRUD ───────────────────────────────────────────────
    const fact = await api(base, 'POST', '/v2/memory', {
      token: forge,
      body: { bot: 'forge', text: 'fsd2-fact', source: 'user', tags: ['battery'] },
    });
    assert.strictEqual(fact.status, 201);
    const factId = fact.json.id;
    assert.ok(factId, 'fact id returned');

    const memList = await api(base, 'GET', '/v2/memory?bot=forge', { token: forge });
    assert.strictEqual(memList.status, 200);
    assert.ok(memList.json.facts.some((f) => f.id === factId && f.text === 'fsd2-fact'));

    const patched = await api(base, 'PATCH', `/v2/memory/${factId}`, {
      token: forge,
      body: { text: 'fsd2-fact-edited' },
    });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.json.text, 'fsd2-fact-edited');

    const removed = await api(base, 'DELETE', `/v2/memory/${factId}`, { token: forge });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.json.id, factId);
    const gone = await api(base, 'GET', `/v2/memory/${factId}`, { token: forge });
    assert.strictEqual(gone.status, 404);

    // ── 7. deeplink /d/ resolution — happy + miss ────────────────────
    const dlSeq = await api(base, 'GET', '/d/CONTROL/o/auditentry/seq_1', { token: forge });
    assert.strictEqual(dlSeq.status, 200);
    assert.strictEqual(dlSeq.json.resolved, true);
    assert.strictEqual(dlSeq.json.domain, 'CONTROL');
    assert.strictEqual(dlSeq.json.object.seq, 1);

    const dlMem = await api(base, 'GET', `/d/BRAIN/o/memory/${factId}`, { token: forge });
    assert.strictEqual(dlMem.status, 404); // fact was deleted above — uniform miss
    assert.strictEqual(dlMem.json.resolved, false);

    const fact2 = await api(base, 'POST', '/v2/memory', {
      token: forge,
      body: { bot: 'forge', text: 'deeplink-target' },
    });
    assert.strictEqual(fact2.status, 201);
    const dlMem2 = await api(base, 'GET', `/d/BRAIN/o/memory/${fact2.json.id}`, { token: forge });
    assert.strictEqual(dlMem2.status, 200);
    assert.strictEqual(dlMem2.json.resolved, true);
    assert.strictEqual(dlMem2.json.object.text, 'deeplink-target');

    // Misses: unknown object, unknown type — 404 with a stable reason,
    // never a silent redirect.
    const dlMiss = await api(base, 'GET', '/d/OUTPUT/o/artifact/art_zzzzzz', { token: forge });
    assert.strictEqual(dlMiss.status, 404);
    assert.strictEqual(dlMiss.json.resolved, false);
    assert.strictEqual(dlMiss.json.reason, 'not_found');
    const dlBad = await api(base, 'GET', '/d/NOW/o/nonsense/r_00000000', { token: forge });
    assert.strictEqual(dlBad.status, 404);
    assert.strictEqual(dlBad.json.reason, 'unknown_type');
    const dlNoAuth = await api(base, 'GET', '/d/NOW/o/run/r_00000000');
    assert.strictEqual(dlNoAuth.status, 401);

    // Chain still sealed after the whole battery.
    const finalVerify = await api(base, 'GET', '/v1/audit/verify', { token: atlas });
    assert.strictEqual(finalVerify.status, 200);
    assert.strictEqual(finalVerify.json.ok, true);
  } finally {
    await g.close();
  }
});
