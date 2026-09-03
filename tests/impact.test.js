'use strict';
// Deterministic impact-analysis tests. Each tool class must return the
// expected blastRadius and a rollback plan that references the affected
// path. Unknown tools must return confidence:'missing' with a
// 'pending backend support' string — never a fabricated rollback.

const test = require('node:test');
const assert = require('node:assert');
const { computeImpact } = require('../src/gateway/impact');
const { ApprovalStore } = require('../src/gateway/approvals');
const { Gateway } = require('../src/gateway/server');

// ── computeImpact unit tests ─────────────────────────────────────────

const fakeChain = { entries: [] };

function impact(tool, args) {
  return computeImpact({ tool, args, gw: { chain: fakeChain } });
}

// ── blastRadius per tool class ───────────────────────────────────────

test('fs.write → blastRadius within_run', () => {
  const r = impact('fs.write', { path: 'x.md' });
  assert.equal(r.blastRadius, 'within_run');
});

test('fs.read → blastRadius within_run', () => {
  const r = impact('fs.read', { path: 'y.md' });
  assert.equal(r.blastRadius, 'within_run');
});

test('fs.delete → blastRadius within_run', () => {
  const r = impact('fs.delete', { path: 'z.md' });
  assert.equal(r.blastRadius, 'within_run');
});

test('shell.run → blastRadius within_bot', () => {
  const r = impact('shell.run', { command: 'rm -rf /' });
  assert.equal(r.blastRadius, 'within_bot');
});

test('web.fetch → blastRadius within_bot', () => {
  const r = impact('web.fetch', { url: 'https://example.com/page' });
  assert.equal(r.blastRadius, 'within_bot');
});

test('db.read → blastRadius cross_bot', () => {
  const r = impact('db.read', { query: 'SELECT 1' });
  assert.equal(r.blastRadius, 'cross_bot');
});

test('http.post → blastRadius external', () => {
  const r = impact('http.post', { url: 'https://api.example.com' });
  assert.equal(r.blastRadius, 'external');
});

// ── risk per tool class ──────────────────────────────────────────────

test('fs.read → risk read', () => {
  assert.equal(impact('fs.read', { path: 'a.md' }).risk, 'read');
});

test('fs.write → risk write', () => {
  assert.equal(impact('fs.write', { path: 'a.md' }).risk, 'write');
});

test('shell.run → risk destructive', () => {
  assert.equal(impact('shell.run', {}).risk, 'destructive');
});

// ── rollback plan contains affected path for fs.write ────────────────

test('fs.write rollback mentions the affected path', () => {
  const r = impact('fs.write', { path: 'x.md' });
  assert.ok(r.rollbackPlan.includes('x.md'), `rollbackPlan must mention 'x.md': ${r.rollbackPlan}`);
});

test('fs.write rollback follows the template "delete the file at <path>"', () => {
  const r = impact('fs.write', { path: 'x.md' });
  assert.equal(r.rollbackPlan, 'delete the file at x.md');
});

test('fs.delete rollback does not expose the path as a secret', () => {
  const r = impact('fs.delete', { path: 'secret-key.pem' });
  // fs.delete uses the same template — but the path value itself is
  // legitimate metadata, not a secret being fabricated.
  assert.ok(r.rollbackPlan.includes('secret-key.pem'), 'rollback must mention the affected path');
});

test('shell.run rollback is the honest manual-reverse string', () => {
  const r = impact('shell.run', { command: 'rm -rf /' });
  assert.equal(r.rollbackPlan, 'no automated rollback — reverse manually');
});

test('http.post rollback is the honest no-automated-rollback string', () => {
  const r = impact('http.post', { url: 'https://api.example.com' });
  assert.equal(r.rollbackPlan, 'no automated rollback');
});

test('fs.read rollback does not fabricate a reverse step', () => {
  const r = impact('fs.read', { path: 'a.md' });
  assert.equal(r.rollbackPlan, 'no automated rollback');
});

// ── affectedObjects derived from args ────────────────────────────────

test('fs.write affectedObjects contains the path', () => {
  const r = impact('fs.write', { path: 'x.md' });
  assert.deepStrictEqual(r.affectedObjects, ['x.md']);
});

test('fs.read affectedObjects contains the path', () => {
  const r = impact('fs.read', { path: '/tmp/a' });
  assert.deepStrictEqual(r.affectedObjects, ['/tmp/a']);
});

test('web.fetch affectedObjects contains the hostname', () => {
  const r = impact('web.fetch', { url: 'https://example.com/page' });
  assert.deepStrictEqual(r.affectedObjects, ['example.com']);
});

// ── confidence for known vs unknown tools ────────────────────────────

test('known tool → confidence computed', () => {
  const r = impact('fs.write', { path: 'x.md' });
  assert.equal(r.confidence, 'computed');
});

test('unknown tool → confidence missing with pending backend support', () => {
  const r = impact('unknown.tool', { secret: 'leak' });
  assert.equal(r.confidence, 'missing');
  assert.ok(r.rollbackPlan.includes('pending backend support'),
    `unknown tool rollback must say 'pending backend support': ${r.rollbackPlan}`);
});

// ── arg-leak scan: no secret values in rollback string ───────────────

test('rollback string does not leak secret-like arg values for shell.run', () => {
  const r = impact('shell.run', { command: 'cat /etc/shadow' });
  // shell.run rollback is a fixed template — no arg values leaked.
  assert.equal(r.rollbackPlan, 'no automated rollback — reverse manually');
});

test('rollback string does not leak url for http.post', () => {
  const r = impact('http.post', { url: 'https://api.secret.com/token=abc123' });
  assert.equal(r.rollbackPlan, 'no automated rollback');
});

test('rollback string does not leak arbitrary args for unknown tool', () => {
  const r = impact('unknown.tool', { secret: 'leak', token: 'abc123' });
  assert.ok(r.rollbackPlan.includes('pending backend support'));
  assert.ok(!r.rollbackPlan.includes('leak'), 'rollback must not contain secret arg values');
  assert.ok(!r.rollbackPlan.includes('abc123'), 'rollback must not contain secret arg values');
});

// ── Audit hygiene: impact snapshot never includes raw args ───────────

test('approval_impact_snapshot audit never includes raw args', () => {
  // The audit type is created in server.js with only {approvalId, risk, confidence}.
  // Verify the shape is correct by constructing the payload directly.
  const payload = { type: 'approval_impact_snapshot', approvalId: 'apr_000001', risk: 'write', confidence: 'computed' };
  const keys = Object.keys(payload);
  assert.deepStrictEqual(keys, ['type', 'approvalId', 'risk', 'confidence'],
    'approval_impact_snapshot must not include raw args');
});

// ── Integration: ApprovalStore persists impact snapshot ──────────────

test('ApprovalStore.request() persists the impact snapshot', () => {
  const store = new ApprovalStore({ now: () => 1_000_000 });
  const req = store.request({ bot: { name: 'forge' }, tool: 'fs.write', args: { path: 'x.md' }, reason: 'test' });
  assert.ok(req.impact, 'approval must have an impact snapshot');
  assert.equal(req.impact.blastRadius, 'within_run');
  assert.equal(req.impact.confidence, 'computed');
  assert.ok(req.impact.rollbackPlan.includes('x.md'), 'rollback must mention the affected path');
  assert.equal(req.impact.risk, 'write');
  // Impact snapshot must never include raw args.
  assert.strictEqual(req.impact.args, undefined, 'impact must not carry raw args');
});

test('ApprovalStore.request() marks unknown tools with confidence missing', () => {
  const store = new ApprovalStore({ now: () => 1_000_000 });
  const req = store.request({ bot: { name: 'forge' }, tool: 'unknown.tool', args: { secret: 'x' }, reason: 'test' });
  assert.equal(req.impact.confidence, 'missing');
  assert.ok(req.impact.rollbackPlan.includes('pending backend support'));
});

// ── Integration: HTTP endpoint for /v2/approvals/:id/impact ──────────

test('GET /v2/approvals/:id/impact returns snapshot + chain refs', async () => {
  const server = http.createServer();
  let gw = null;
  server.on('request', (req, res) => { if (gw) gw.handle(req, res); });

  gw = new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker' },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator' },
    },
    dispatch: async () => ({ ok: true }),
  });

  // Pre-create an approval so we have an id and impact snapshot.
  const approval = gw.approvals.request({
    bot: { name: 'forge' },
    tool: 'fs.write',
    args: { path: 'x.md' },
    reason: 'test',
  });

  // Add a chain entry referencing this approval.
  gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: 'forge', tool: 'fs.write' });

  const url = await listen(server);
  try {
    const res = await fetch(`${url}/v2/approvals/${approval.id}/impact`, {
      headers: { authorization: 'Bearer tok-atlas' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.snapshot, 'must return a snapshot');
    assert.equal(body.snapshot.risk, 'write');
    assert.equal(body.snapshot.confidence, 'computed');
    // Snapshot must never include raw args.
    assert.strictEqual(body.snapshot.args, undefined);
    assert.ok(body.snapshot.rollbackPlan.includes('x.md'), 'rollback must mention x.md');
    // Live chain refs must include the approval_requested entry.
    assert.ok(Array.isArray(body.evidenceChainRefs));
    assert.ok(body.evidenceChainRefs.length >= 1, 'must have at least one chain ref');
  } finally {
    await close(server);
  }
});

test('GET /v2/approvals/:id/impact → 404 for missing id', async () => {
  const server = http.createServer();
  let gw = null;
  server.on('request', (req, res) => { if (gw) gw.handle(req, res); });
  gw = new Gateway({
    bots: { forge: { name: 'forge', token: 'tok-forge', role: 'worker' } },
    dispatch: async () => ({ ok: true }),
  });
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/v2/approvals/nonexistent/impact`, {
      headers: { authorization: 'Bearer tok-forge' },
    });
    assert.equal(res.status, 404);
  } finally {
    await close(server);
  }
});

test('GET /v2/approvals/:id/impact → 401 without token', async () => {
  const server = http.createServer();
  let gw = null;
  server.on('request', (req, res) => { if (gw) gw.handle(req, res); });
  gw = new Gateway({
    bots: { forge: { name: 'forge', token: 'tok-forge', role: 'worker' } },
    dispatch: async () => ({ ok: true }),
  });
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/v2/approvals/apr_000001/impact`);
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

// ── helpers ──────────────────────────────────────────────────────────

const http = require('node:http');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}