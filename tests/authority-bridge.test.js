'use strict';
// Tests for aie_authority_bridge.py — read-only authority state surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AIE_DIR = process.env.AIE_RUNTIME_PATH || path.join(__dirname, '..', '..', 'aie');
const BRIDGE = path.join(AIE_DIR, 'scripts', 'aie_authority_bridge.py');
const PY = process.env.AIE_PYTHON || 'python';

function makeState() {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-bridge-')), 'aie-state.db');
  const setup = `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(AIE_DIR, 'src'))})
from aie_runtime.engine import AuthorityLease, Principal, Mission, AdmissionOutcome
from aie_runtime.persistent_state import PersistentState
from datetime import datetime, timedelta, timezone
state = PersistentState(db_path=${JSON.stringify(db)})
state.principals['p1'] = Principal(id='p1', type='bot', identity_ref='tg')
state.missions['m1'] = Mission(id='m1', state='active')
state.leases['lease1'] = AuthorityLease(
    id='lease1', principal_id='p1', mission_id='m1',
    capabilities={'execute'}, resource_prefixes=('tools:',),
    expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    budget_remaining=50.0, revoked=False)
print('ok')`;
  execFileSync(PY, ['-c', setup], { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE_DIR, 'src') } });
  return db;
}

function bridge(args) {
  return JSON.parse(execFileSync(PY, [BRIDGE, '--state', AIE_STATE(), ...args],
    { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE_DIR, 'src') } }).toString());
}

function AIE_STATE() { return globalThis.__aieState; }

test('authority bridge: counts mode returns all kinds', () => {
  const db = makeState();
  globalThis.__aieState = db;
  const out = bridge([]);
  assert.deepEqual(out.kinds, ['leases', 'missions', 'admissions', 'outcomes', 'evidence']);
  assert.ok(out.counts.leases >= 1);
});

test('authority bridge: leases mode returns lease list', () => {
  const db = makeState();
  globalThis.__aieState = db;
  const out = bridge(['--kind', 'leases']);
  assert.equal(out.kind, 'leases');
  assert.ok(Array.isArray(out.items));
  assert.ok(out.items.length >= 1);
});

test('authority bridge: corrupt state exits 1 (fail-closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-corrupt-'));
  const db = path.join(dir, 'bad.db');
  fs.writeFileSync(db, 'not-a-sqlite-file');
  let exitCode = 0;
  try {
    execFileSync(PY, [BRIDGE, '--state', db],
      { timeout: 60000, env: { ...process.env, PYTHONPATH: path.join(AIE_DIR, 'src') }, stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 1, 'bridge must exit 1 on corrupt state');
});
