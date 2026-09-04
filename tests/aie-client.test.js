'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const CLIENT = path.resolve(__dirname, '../src/gateway/aie-client.js');
const AIE_DIR = process.env.AIE_RUNTIME_PATH || path.resolve(__dirname, '../../aie');
const BRIDGE = path.join(AIE_DIR, 'scripts/aie_revalidate_bridge.py');
const PY = process.env.AIE_PYTHON || 'python';
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg aie '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Fresh child config avoids shared environment and module-cache pollution.
function revalidate(id, env, context = null) {
  const script = 'console.log(JSON.stringify(require(process.argv[1]).revalidate(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))))';
  return JSON.parse(execFileSync(process.execPath, ['-e', script, CLIENT, JSON.stringify(id), JSON.stringify(context)], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000,
  }));
}
function bridgeDouble(t, stdout, status) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'scripts'));
  // Real subprocess double at the protocol boundary, run by Node.
  fs.writeFileSync(path.join(dir, 'scripts/aie_revalidate_bridge.py'),
    `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${status});`);
  return { AIE_RUNTIME_PATH: dir, AIE_PYTHON: process.execPath, AIE_STATE_FILE: path.join(dir, 'state.db') };
}
test('missing interpreter fails closed even with server escape hatch set', t => {
  assert.deepEqual(revalidate('action_x', { AIE_PYTHON: path.join(tempDir(t), 'missing-python'),
    TG_AIE_FAIL_OPEN: 'true' }), { ok: false, code: 'AIE_UNREACHABLE' });
});
for (const [label, stdout, status, expected] of [
  ['success', '{"ok":true}', 0, { ok: true }],
  ['revoked', '{"ok":false,"code":"AIE-AUTH-003"}', 1, { ok: false, code: 'AIE-AUTH-003' }],
  ['failed process claiming success', '{"ok":true}', 1, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['truthy non-boolean', '{"ok":"false"}', 0, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['missing decision', '{}', 0, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['non-JSON', 'not json', 0, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['mixed stdout', 'unexpected log\n{"ok":true}', 0, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['inconsistent rejection exit', '{"ok":false,"code":"AIE-AUTH-003"}', 0, { ok: false, code: 'AIE_UNREACHABLE' }],
  ['invalid error code', '{"ok":false,"code":{"secret":"not a code"}}', 1, { ok: false, code: 'AIE_UNREACHABLE' }],
]) test(`bridge protocol: ${label}`, t => {
  assert.deepEqual(revalidate('action_x', bridgeDouble(t, stdout, status)), expected);
});
test('invalid action IDs cannot be authorized by positive bridge output', t => {
  const env = bridgeDouble(t, '{"ok":true}', 0);
  for (const id of ['', null, 7, { id: 'action_x' }])
    assert.deepEqual(revalidate(id, env), { ok: false, code: 'AIE-AUTH-004' });
});
test('TG client checks persisted admissions after restart and rejects changed authority', {
  skip: !fs.existsSync(BRIDGE) ? 'co-located AIE absent; set AIE_RUNTIME_PATH for integration' : false,
}, t => {
  const db = path.join(tempDir(t), 'authority.db');
  const env = { AIE_RUNTIME_PATH: AIE_DIR, AIE_PYTHON: PY, AIE_STATE_FILE: db };
  const prelude = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'src'))
from aie_runtime.engine import AdmissionEngine, ActionRequest, Principal, Mission, AuthorityLease
from aie_runtime.persistent_state import PersistentState
from datetime import datetime, timedelta, timezone
state = PersistentState(db_path=sys.argv[2])
`;
  function python(code) {
    execFileSync(PY, ['-c', prelude + code, AIE_DIR, db], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env },
    });
  }
  python(`
state.principals['worker'] = Principal(id='worker', type='bot', identity_ref='tg')
state.missions['mission'] = Mission(id='mission', state='active')
state.leases['lease'] = AuthorityLease(id='lease', principal_id='worker', mission_id='mission',
    capabilities={'execute'}, resource_prefixes=('tools:',),
    expires_at=datetime.now(timezone.utc) + timedelta(hours=1), budget_remaining=50.0)
engine = AdmissionEngine(state=state, policy=lambda _: True)
result = engine.admit(ActionRequest(action_id='action_live', principal_id='worker', mission_id='mission',
    lease_id='lease', capability='execute', resource='tools:x', budget_cost=1.0))
assert result.status == 'admitted'
state.save_all()
state._conn.close()
`);
  assert.deepEqual(revalidate('action_live', env), { ok: true });
  assert.deepEqual(revalidate('action_live', env, { bot: 'worker', tool: 'fs.read', args: null }),
    { ok: false, code: 'AIE-AUTH-004' }, 'TG execution must reject an unbound admission');
  assert.deepEqual(revalidate('unknown', env), { ok: false, code: 'AIE-AUTH-004' });
  assert.deepEqual(revalidate("'; print('injected') #", env), { ok: false, code: 'AIE-AUTH-004' });
  python(`
lease = state.leases['lease']
lease.revoked = True
state.leases['lease'] = lease
state._conn.close()
`);
  assert.deepEqual(revalidate('action_live', env), { ok: false, code: 'AIE-AUTH-003' });
  python(`
lease = state.leases['lease']
lease.revoked = False
lease.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
state.leases['lease'] = lease
state._conn.close()
`);
  assert.deepEqual(revalidate('action_live', env), { ok: false, code: 'AIE-AUTH-002' });
});
