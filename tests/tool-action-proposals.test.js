'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolActionProposalStore } = require('../src/gateway/tool-action-proposals');

function request(overrides = {}) {
  return {
    requestId: 'req-1',
    toolId: 'github.read',
    capability: 'github.pr.read',
    toolProvenanceDigest: 'a'.repeat(64),
    principalId: 'operator-1',
    missionId: 'mission-1',
    executionContextId: 'ctx-1',
    idempotencyKey: 'idem-1',
    argumentsDigest: 'b'.repeat(64),
    ...overrides,
  };
}

test('ToolActionProposalStore persists safe digest-only proposal state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tool-actions-'));
  const file = path.join(dir, 'tool-actions.json');
  const store = new ToolActionProposalStore({ file, now: () => 1000 });
  const created = store.createOrGet({
    tenantId: 'main',
    request: request(),
    admission: { decision: 'pending_approval', classification: 'destructive', reasonCode: 'human_required' },
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.proposal.state, 'pending_approval');

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('"arguments"'), false);
  assert.equal(raw.includes('"credentials"'), false);
  assert.equal(raw.includes('"token"'), false);
  assert.equal(raw.includes('"apiKey"'), false);
  assert.ok(raw.includes('b'.repeat(64)));
});

test('ToolActionProposalStore idempotency returns same proposal and rejects identity substitution', () => {
  const store = new ToolActionProposalStore();
  const first = store.createOrGet({
    tenantId: 'main',
    request: request(),
    admission: { decision: 'pending_approval', classification: 'destructive' },
  });
  const again = store.createOrGet({
    tenantId: 'main',
    request: request(),
    admission: { decision: 'pending_approval', classification: 'destructive' },
  });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.proposal.requestId, first.proposal.requestId);

  const conflict = store.createOrGet({
    tenantId: 'main',
    request: request({ toolId: 'different.tool' }),
    admission: { decision: 'pending_approval', classification: 'destructive' },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_conflict');
});

test('ToolActionProposalStore expires pending approvals fail closed', () => {
  let now = 1000;
  const store = new ToolActionProposalStore({ now: () => now, ttlMs: 100 });
  const created = store.createOrGet({
    tenantId: 'main',
    request: request(),
    admission: { decision: 'pending_approval', classification: 'destructive' },
  });
  store.attachNeedsYou(created.proposal.requestId, 'nys_000001');
  now = 1101;
  const expired = store.get(created.proposal.requestId);
  assert.equal(expired.state, 'expired');
  const decision = store.decide(expired.requestId, 'approve', 'operator');
  assert.equal(decision.ok, false);
  assert.equal(decision.error, 'not_pending_approval');
});

test('ToolActionProposalStore approve is state-only and creates no dispatch reference', () => {
  const store = new ToolActionProposalStore();
  const created = store.createOrGet({
    tenantId: 'main',
    request: request(),
    admission: { decision: 'pending_approval', classification: 'destructive' },
  });
  store.attachNeedsYou(created.proposal.requestId, 'nys_000001');
  const approved = store.decide(created.proposal.requestId, 'approve', 'operator');
  assert.equal(approved.ok, true);
  assert.equal(approved.proposal.state, 'approved');
  assert.equal(approved.proposal.dispatchRef, null);
  assert.equal(approved.proposal.receiptRef, null);
});
