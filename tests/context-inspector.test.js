'use strict';
// Context Inspector v1 tests: layer aggregation, self/other RBAC, snapshot determinism.
const test = require('node:test');
const assert = require('node:assert/strict');

const mount = require('../src/gateway/mounts/25-context.js');
const { buildContextSnapshot } = require('../src/gateway/context-inspector.js');

function fakeRes() {
  return { statusCode: null, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
function run(mountFn, gw, pathStr, botName = 'self-bot', role = 'worker') {
  const res = fakeRes();
  return mountFn.handle(gw, { method: 'GET', headers: {} }, res,
    { url: new URL(`http://x${pathStr}`), bot: { name: botName, role, capabilities: [] } })
    .then(() => res);
}

test('snapshot aggregates all layers with provenance + content-addressed hash', async () => {
  const gw = {
    _audit: () => {},
    _agentStore: { get: () => ({ id: 'b1' }), getProfile: () => ({ persona: 'tester' }) },
    budgets: { get: () => ({ spentUsd: 1, budgetUsd: 10 }) },
    _memoryStore: { list: () => [{ key: 'k1', value: 'v1' }] },
    _projectStore: { list: () => [{ id: 'p1', title: 'P', status: 'active', health: 'healthy', missions: [], conversations: [] }] },
    approvals: { listPending: () => [{ bot: 'b1', tool: 'fs.read:x', status: 'pending', createdAt: 1 }] },
  };
  const res = await run(mount, gw, '/v2/context/b1', 'b1', 'worker');
  assert.equal(res.statusCode, 200);
  const snap = JSON.parse(res.body);
  const layerNames = snap.layers.map((l) => l.layer);
  assert.deepEqual(layerNames, ['identity', 'authority', 'budget', 'memory', 'projects', 'approvals']);
  assert.ok(snap.snapshot_hash, 'content-addressed');
  assert.equal(snap.layers[0].data.registered, true);
  assert.equal(snap.layers[2].data.state.budgetUsd, 10);
  assert.equal(snap.layers[5].data.pending, 1);
});

test('self-inspection allowed for worker role; other bot requires operator', async () => {
  const gw = { _audit: () => {} };
  const self = await run(mount, gw, '/v2/context/b1', 'b1', 'worker');
  assert.equal(self.statusCode, 200);

  const other = await run(mount, gw, '/v2/context/other-bot', 'b1', 'worker');
  assert.equal(other.statusCode, 403);
  assert.equal(JSON.parse(other.body).error, 'operator_required');

  const op = await run(mount, gw, '/v2/context/other-bot', 'b1', 'operator');
  assert.equal(op.statusCode, 200);
});

test('snapshot is deterministic for identical inputs (hash stability)', () => {
  const args = {
    botName: 'b1',
    agentStore: { get: () => null },
    budgets: null,
    memoryStore: { list: () => [] },
    projectStore: { list: () => [] },
    approvals: { listPending: () => [] },
    worksConfigured: false,
  };
  const a = require('../src/gateway/context-inspector.js').buildContextSnapshot(args);
  const s1 = require('../src/gateway/context-inspector.js').buildContextSnapshot(args);
  assert.equal(a.snapshot_hash, s1.snapshot_hash);
});

test('missing stores degrade gracefully (error field, not crash)', async () => {
  const gw = { _audit: () => {} };
  const res = await run(mount, gw, '/v2/context/b1', 'b1', 'operator');
  assert.equal(res.statusCode, 200);
  const snap = JSON.parse(res.body);
  const identity = snap.layers.find((l) => l.layer === 'identity');
  assert.equal(identity.data.error, 'agent_store_unavailable');
});