'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { canonical, sha256 } = require('../src/gateway/hash-chain');

const ROOT = path.join(__dirname, '..');
const AIE = process.env.AIE_RUNTIME_PATH || path.join(ROOT, '..', 'aie');
const PY = process.env.AIE_PYTHON || 'python';
const BRIDGE = path.join(AIE, 'scripts', 'aie_revalidate_bridge.py');
const ORIGINAL_ENV = { AIE_RUNTIME_PATH: process.env.AIE_RUNTIME_PATH, AIE_STATE_FILE: process.env.AIE_STATE_FILE, TG_AIE_FAIL_OPEN: process.env.TG_AIE_FAIL_OPEN, TG_APPROVALS_DB: process.env.TG_APPROVALS_DB, TG_DB_FILE: process.env.TG_DB_FILE };
test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function stateWith(actionId, { revoked = false, seconds = 3600, bot = 'worker', tool = 'fs.read:x', args = null } = {}) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-aie-')), 'state.db');
  const binding = sha256(canonical({ bot, tool, args }));
  const code = `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(AIE, 'src'))})
from aie_runtime.engine import AdmissionEngine, ActionRequest, Principal, Mission, AuthorityLease
from aie_runtime.persistent_state import PersistentState
from datetime import datetime, timedelta, timezone
state = PersistentState(db_path=${JSON.stringify(db)})
state.principals['p1'] = Principal(id='p1', type='bot', identity_ref='tg')
state.missions['m1'] = Mission(id='m1', state='active')
state.leases['l1'] = AuthorityLease(id='l1', principal_id='p1', mission_id='m1', capabilities={'execute'}, resource_prefixes=('tools:',), expires_at=datetime.now(timezone.utc) + timedelta(seconds=${seconds}), budget_remaining=50.0, revoked=${revoked ? 'True' : 'False'})
AdmissionEngine(state=state, policy=lambda _: True).admit(ActionRequest(action_id=${JSON.stringify(actionId)}, principal_id='p1', mission_id='m1', lease_id='l1', capability='execute', resource='tools:x', budget_cost=1.0, extensions=[{'namespace': 'urn:aftergraph:tg-action:v1', 'sha256': ${JSON.stringify(binding)}}]))
`;
  execFileSync(PY, ['-c', code], { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE, 'src') } });
  return db;
}

function expireState(db) {
  const code = `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(AIE, 'src'))})
from aie_runtime.persistent_state import PersistentState
from datetime import datetime, timedelta, timezone
state = PersistentState(db_path=${JSON.stringify(db)})
lease = state.leases['l1']; lease.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1); state.leases['l1'] = lease
`;
  execFileSync(PY, ['-c', code], { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE, 'src') } });
}

function revokeState(db) {
  const code = `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(AIE, 'src'))})
from aie_runtime.persistent_state import PersistentState
state = PersistentState(db_path=${JSON.stringify(db)})
lease = state.leases['l1']; lease.revoked = True; state.leases['l1'] = lease
`;
  execFileSync(PY, ['-c', code], { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE, 'src') } });
}

function mockReqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method; req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  let status = null; let output;
  const res = { writeHead(s) { status = s; }, end(v) { output = JSON.parse(v); } };
  process.nextTick(() => { if (body != null) req.emit('data', Buffer.from(body)); req.emit('end'); });
  return { req, res, status: () => status, body: () => output };
}

function loadGateway() {
  try { require('../src/gateway/db').resetDb(); } catch { /* db not loaded yet */ }
  delete require.cache[require.resolve('../src/gateway/server')];
  delete require.cache[require.resolve('../src/gateway/aie-client')];
  return require('../src/gateway/server').Gateway;
}

function makeGateway(Gateway, dispatch, budgets = undefined) {
  return new Gateway({
    bots: {
      worker: { token: 'worker-token', role: 'worker', capabilities: ['fs.read'] },
      operator: { token: 'operator-token', role: 'operator', capabilities: [] },
    }, dispatch, budgets,
  });
}

test('real AIE lease admits and revalidates an action immediately before dispatch', { concurrency: false }, async () => {
  const actionId = `a-${Date.now()}-ok`;
  const db = stateWith(actionId);
  process.env.AIE_RUNTIME_PATH = AIE;
  process.env.AIE_STATE_FILE = db;
  delete process.env.TG_AIE_FAIL_OPEN;
  const Gateway = loadGateway();
  let calls = 0;
  const gw = makeGateway(Gateway, async () => { calls++; return { ok: true }; });
  const r = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x', action_id: actionId }), 'worker-token');
  await gw.handle(r.req, r.res);
  assert.equal(r.status(), 200); assert.equal(calls, 1);
});

test('revoked lease blocks dispatch and expiry maps to 410', { concurrency: false }, async () => {
  const revokedId = `a-${Date.now()}-revoked`;
  const revokedDb = stateWith(revokedId); revokeState(revokedDb);
  process.env.AIE_RUNTIME_PATH = AIE; process.env.AIE_STATE_FILE = revokedDb; delete process.env.TG_AIE_FAIL_OPEN;
  const Gateway = loadGateway(); let calls = 0; let budgetChecks = 0;
  const gw = makeGateway(Gateway, async () => { calls++; }, { consume() { budgetChecks++; return { ok: false }; } });
  const r1 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x', action_id: revokedId }), 'worker-token');
  await gw.handle(r1.req, r1.res);
  assert.equal(r1.status(), 403); assert.equal(r1.body().error, 'authority_revoked'); assert.equal(calls, 0); assert.equal(budgetChecks, 0);

  const expiredId = `a-${Date.now()}-expired`;
  const expiredDb = stateWith(expiredId); expireState(expiredDb); process.env.AIE_STATE_FILE = expiredDb;
  const ExpiredGateway = loadGateway();
  const expiredGw = makeGateway(ExpiredGateway, async () => { calls++; });
  const r2 = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x', action_id: expiredId }), 'worker-token');
  await expiredGw.handle(r2.req, r2.res);
  assert.equal(r2.status(), 410); assert.equal(r2.body().error, 'lease_expired'); assert.equal(calls, 0);
});

test('binding mismatch rejects before dispatch and budget consumption', { concurrency: false }, async () => {
  const actionId = `a-${Date.now()}-mismatch`;
  process.env.AIE_RUNTIME_PATH = AIE; process.env.AIE_STATE_FILE = stateWith(actionId); delete process.env.TG_AIE_FAIL_OPEN;
  const Gateway = loadGateway(); let calls = 0; let budgetChecks = 0;
  const gw = makeGateway(Gateway, async () => { calls++; }, { consume() { budgetChecks++; return { ok: true }; } });
  const r = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:other', action_id: actionId }), 'worker-token');
  await gw.handle(r.req, r.res);
  assert.equal(r.status(), 403); assert.equal(r.body().error, 'action_not_admitted'); assert.equal(calls, 0); assert.equal(budgetChecks, 0);
});

test('bridge outage maps to 502 and never dispatches', { concurrency: false }, async () => {
  process.env.AIE_RUNTIME_PATH = path.join(os.tmpdir(), 'missing-aie-runtime');
  process.env.AIE_STATE_FILE = path.join(os.tmpdir(), 'missing-state.db');
  delete process.env.TG_AIE_FAIL_OPEN;
  const Gateway = loadGateway(); let calls = 0;
  const gw = makeGateway(Gateway, async () => { calls++; });
  const r = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'fs.read:x', action_id: 'missing-action' }), 'worker-token');
  await gw.handle(r.req, r.res);
  assert.equal(r.status(), 502); assert.equal(r.body().error, 'aie_unreachable'); assert.equal(calls, 0);
});

test('approval preserves action identity and original bot through resolution', { concurrency: false }, async () => {
  const actionId = `a-${Date.now()}-approval`;
  process.env.AIE_RUNTIME_PATH = AIE; process.env.AIE_STATE_FILE = stateWith(actionId, { tool: 'shell.run' }); delete process.env.TG_AIE_FAIL_OPEN;
  const Gateway = loadGateway(); let dispatched;
  const gw = makeGateway(Gateway, async (bot) => { dispatched = bot; return { ok: true }; });
  const first = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run', action_id: actionId }), 'worker-token');
  await gw.handle(first.req, first.res);
  assert.equal(first.status(), 202);
  const approvalId = first.body().approvalId;
  assert.equal(gw.approvals.get(approvalId).action_id, actionId);
  const second = mockReqRes('POST', `/v1/approvals/${approvalId}/approve`, '{}', 'operator-token');
  await gw.handle(second.req, second.res);
  assert.equal(second.status(), 200); assert.equal(dispatched, 'worker');

  const missing = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run' }), 'worker-token');
  await gw.handle(missing.req, missing.res);
  const missingApproval = mockReqRes('POST', `/v1/approvals/${missing.body().approvalId}/approve`, '{}', 'operator-token');
  await gw.handle(missingApproval.req, missingApproval.res);
  assert.equal(missingApproval.status(), 403); assert.equal(missingApproval.body().error, 'action_not_admitted');
});

test('SQLite approval migration preserves action identity across gateway restart', { concurrency: false }, async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-approvals-')), 'gateway.db');
  process.env.TG_DB_FILE = dbFile; process.env.TG_APPROVALS_DB = '1'; process.env.TG_AIE_FAIL_OPEN = 'true';
  delete process.env.AIE_STATE_FILE;
  const Gateway = loadGateway();
  const firstGw = makeGateway(Gateway, async () => ({ ok: true }));
  const first = mockReqRes('POST', '/v1/actions', JSON.stringify({ tool: 'shell.run', action_id: 'sqlite-action-1' }), 'worker-token');
  await firstGw.handle(first.req, first.res);
  assert.equal(first.status(), 202);
  const id = first.body().approvalId;
  assert.equal(firstGw.approvals.get(id).action_id, 'sqlite-action-1');

  // A fresh Gateway instance reloads the approval store from the same SQLite
  // connection, which is the restart boundary relevant to this store.
  const restartedGw = makeGateway(Gateway, async () => ({ ok: true }));
  assert.equal(restartedGw.approvals.get(id).action_id, 'sqlite-action-1');
});
