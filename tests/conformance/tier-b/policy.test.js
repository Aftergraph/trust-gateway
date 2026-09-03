'use strict';
// FS-F2 conformance tier-B — POLICY deep battery.
//
// Beyond the tier-A smoke: the FULL allow / needs_approval / deny matrix over
// the CLASSIFICATIONS table, driven through the REAL /v1/actions decision
// endpoint of a real spawned gateway (tests/fs-helpers.js), plus the
// propose → deny/approve lifecycle for every class that parks an approval.
//
// Decision contract (src/gateway/policy.js):
//   read         → allow, always (pre-approved)
//   write +cap   → allow          write −cap   → needs_approval
//   destructive  → needs_approval, ALWAYS (even operator with '*')
//   secret +cap  → needs_approval secret −cap  → deny (403)
//   unclassified → fails CLOSED to destructive
//
// Zero deps beyond node: builtins. Spawns its own gateways; never touches a
// live GATEWAY_URL process.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnGateway, api, TOKENS, JAIL_FILE_REL, JAIL_FILE_TEXT } = require('../../fs-helpers');

const TESTS = [];
function t(name, fn) { TESTS.push({ name, fn }); }

// Every captured HTTP body — grepped for leaked material at the end.
const RESPONSES = [];

async function act(base, token, tool, args) {
  const r = await api(base, 'POST', '/v1/actions', { token, body: { tool, args } });
  RESPONSES.push(JSON.stringify(r.json || r.text));
  return r;
}

// ── 1. the classification matrix ─────────────────────────────────────────

t('matrix: read class → allow + actually executed over the jailed fs', async (gw) => {
  const r = await act(gw.base, TOKENS.forge, 'fs.read:' + JAIL_FILE_REL, null);
  assert.equal(r.status, 200, 'read is pre-approved → 200');
  assert.equal(r.json.decision, 'allow');
  assert.ok(String(r.json.result && r.json.result.content).includes(JAIL_FILE_TEXT),
    'jailed fs.read returned the seeded file bytes');
});

t('matrix: write with capability → allow + file bytes land in the jail', async (gw) => {
  const rel = 'tierb/policy-write.txt';
  const body = 'policy-write-' + Date.now();
  const r = await act(gw.base, TOKENS.forge, 'fs.write:' + rel, { content: body });
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'allow');
  // byte-level proof: the file is really on disk inside the bot jail
  const onDisk = fs.readFileSync(path.join(gw.tmp, 'bots', 'forge', rel), 'utf8');
  assert.equal(onDisk, body);
  // and read-back through the gateway matches
  const back = await act(gw.base, TOKENS.forge, 'fs.read:' + rel, null);
  assert.equal(back.json.result.content, body);
});

t('matrix: write WITHOUT capability → needs_approval (202 + approvalId)', async (gw) => {
  const r = await act(gw.base, TOKENS.forge, 'db.write:tierb-t1', { rows: 1 });
  assert.equal(r.status, 202);
  assert.equal(r.json.decision, 'needs_approval');
  assert.ok(/^apr_/.test(r.json.approvalId || ''), 'approval parked with an id');
});

t('matrix: destructive needs approval ALWAYS — even for an operator wildcard', async (gw) => {
  const r = await act(gw.base, TOKENS.atlas, 'shell.run', { cmd: 'echo hi' });
  assert.equal(r.status, 202);
  assert.equal(r.json.decision, 'needs_approval', 'destructive is never auto-allowed');
});

t('matrix: unclassified tool fails CLOSED to destructive (needs_approval)', async (gw) => {
  for (const tool of ['make-money-fast', 'deploy:prod-x', 'harness.build:app-1']) {
    const r = await act(gw.base, TOKENS.forge, tool, null);
    assert.equal(r.status, 202, `unknown tool '${tool}' parked, not executed`);
    assert.equal(r.json.decision, 'needs_approval');
  }
});

t('matrix: secret class — wildcard cap → needs_approval, no cap → deny 403', async (gw) => {
  const capped = await act(gw.base, TOKENS.atlas, 'secret.read:vault', { token: 'tierb-arg-marker' });
  assert.equal(capped.status, 202);
  assert.equal(capped.json.decision, 'needs_approval');
  const uncapped = await act(gw.base, TOKENS.forge, 'credential.use:payments', { key: 'tierb-arg-marker' });
  assert.equal(uncapped.status, 403);
  assert.equal(uncapped.json.decision, 'deny');
  assert.equal(uncapped.json.audited, true, 'denial is write-ahead audited');
});

t('matrix: empty/null tool is classified, not crashed (fail closed)', async (gw) => {
  for (const tool of ['', null]) {
    const r = await act(gw.base, TOKENS.forge, tool, null);
    assert.ok(r.status === 202 || r.status === 403, `degenerate tool '${tool}' still decided`);
    assert.notEqual(r.status, 500, 'no crash on degenerate tool');
  }
});

t('matrix: jailed traversal is refused — never file contents', async (gw) => {
  const r = await act(gw.base, TOKENS.forge, 'fs.read:../../etc/passwd', null);
  assert.ok(r.status >= 400 || r.json.decision === 'deny', `traversal refused, got ${r.status}`);
  assert.ok(!/root:/.test(JSON.stringify(r.json || {})), 'no /etc/passwd material');
});

// ── 2. propose → deny / approve lifecycle, per class ─────────────────────

t('lifecycle: destructive propose → worker approve refused → operator deny → resolved', async (gw) => {
  const prop = await act(gw.base, TOKENS.forge, 'fs.delete:tierb/never.txt', null);
  assert.equal(prop.status, 202);
  const id = prop.json.approvalId;
  // worker may NOT resolve (403), even to deny
  const wk = await api(gw.base, 'POST', `/v1/approvals/${id}/deny`, { token: TOKENS.forge, body: {} });
  assert.equal(wk.status, 403);
  // operator denies
  const den = await api(gw.base, 'POST', `/v1/approvals/${id}/deny`, { token: TOKENS.atlas, body: {} });
  assert.equal(den.status, 200);
  assert.equal(den.json.status, 'denied');
  // resolved record is out of the pending queue
  const pend = await api(gw.base, 'GET', '/v1/approvals', { token: TOKENS.atlas });
  assert.ok(!pend.json.pending.some((p) => p.id === id), 'denied approval leaves pending');
  // re-resolving is a 409 conflict
  const again = await api(gw.base, 'POST', `/v1/approvals/${id}/approve`, { token: TOKENS.atlas, body: {} });
  assert.equal(again.status, 409);
});

t('lifecycle: approve EXECUTES the parked action (operator approves shell.run)', async (gw) => {
  const prop = await act(gw.base, TOKENS.forge, 'shell.run:*', { cmd: 'tierb-echo' });
  assert.equal(prop.status, 202);
  const id = prop.json.approvalId;
  const app = await api(gw.base, 'POST', `/v1/approvals/${id}/approve`, { token: TOKENS.atlas, body: {} });
  assert.ok(app.status === 200 || app.status === 502, `approve → 200/502, got ${app.status}`);
  assert.equal(app.json.status, 'approved', 'approved — execution attempted (worker parked it)');
  // pending queue is empty for this id
  const pend = await api(gw.base, 'GET', '/v1/approvals', { token: TOKENS.atlas });
  assert.ok(!pend.json.pending.some((p) => p.id === id));
});

t('lifecycle: write-without-cap approval round-trip completes', async (gw) => {
  const prop = await act(gw.base, TOKENS.forge, 'db.write:tierb-t2', { rows: 2 });
  assert.equal(prop.status, 202);
  const app = await api(gw.base, 'POST', `/v1/approvals/${prop.json.approvalId}/approve`, { token: TOKENS.atlas, body: {} });
  assert.ok(app.status === 200 || app.status === 502);
  assert.equal(app.json.status, 'approved');
});

t('lifecycle: secret-class approval (capped operator) round-trip completes', async (gw) => {
  const prop = await act(gw.base, TOKENS.atlas, 'credential.use:pay', { key: 'tierb-arg-marker' });
  assert.equal(prop.status, 202);
  const app = await api(gw.base, 'POST', `/v1/approvals/${prop.json.approvalId}/approve`, { token: TOKENS.atlas, body: {} });
  assert.ok(app.status === 200 || app.status === 502);
  assert.equal(app.json.status, 'approved');
});

t('lifecycle: unknown approval id → 404 (never a false approve)', async (gw) => {
  const r = await api(gw.base, 'POST', '/v1/approvals/apr_ghost_tierb/approve', { token: TOKENS.atlas, body: {} });
  assert.equal(r.status, 404);
});

// ── 3. audit hygiene around every decision above ─────────────────────────

t('audit: every decision logged with class+decision, args LENGTH ONLY, chain sealed', async (gw) => {
  const audit = await api(gw.base, 'GET', '/v1/audit', { token: TOKENS.atlas });
  assert.equal(audit.status, 200);
  const decisions = audit.json.entries.filter((e) => e.payload.type === 'action_decision');
  assert.ok(decisions.length >= 10, `one action_decision per action above (${decisions.length})`);
  // every decision row carries class + decision + reason, and NEVER raw args
  for (const e of decisions) {
    assert.ok(['read', 'write', 'destructive', 'secret'].includes(e.payload.class), 'class recorded: ' + e.payload.class);
    assert.ok(['allow', 'needs_approval', 'deny'].includes(e.payload.decision), 'decision recorded');
    assert.equal(e.payload.args, undefined, 'no raw args in audit');
    assert.equal(typeof e.payload.argsLength, 'number', 'args stored as LENGTH only');
  }
  // the secret-class args marker never appears anywhere in the chain
  const blob = JSON.stringify(audit.json);
  assert.ok(!blob.includes('tierb-arg-marker'), 'secret args material leaked into the audit chain');
  const verdict = await api(gw.base, 'GET', '/v1/audit/verify', { token: TOKENS.atlas });
  assert.equal(verdict.json.ok, true, 'chain sealed after the full matrix');
  // nothing we sent came back in any response either
  assert.ok(!RESPONSES.some((r) => r.includes('tierb-arg-marker')), 'secret args leaked in a response');
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  let fails = 0;
  let gw = null;
  try {
    gw = await spawnGateway({});
    for (const { name, fn } of TESTS) {
      try { await fn(gw); console.log('  ✔ ' + name); }
      catch (e) { fails++; console.log('  ✖ ' + name + '\n      → ' + (e && e.message)); }
    }
  } catch (e) {
    console.error('POLICY CRASH', e && e.message);
    process.exit(2);
  } finally {
    if (gw) await gw.close();
  }
  console.log(fails ? '\n✖ POLICY ' + fails + ' failed' : '\n★ POLICY PASS');
  process.exit(fails ? 1 : 0);
})();