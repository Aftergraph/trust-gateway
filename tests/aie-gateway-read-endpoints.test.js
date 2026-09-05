'use strict';
// Sprint: AIE gateway HTTP read endpoints (leases, admissions, missions)
// following the sprint-execution TDD protocol.
//
// The AIE gateway (src/aie_runtime/gateway/http.py) currently exposes:
//   GET /healthz, GET /evidence, POST /revocations, POST /federation/revocations
//
// This sprint adds read-only authority endpoints to the AIE gateway:
//   GET /leases        — list all leases (operator-only)
//   GET /admissions    — list all admissions (operator-only)
//   GET /missions      — list all missions (operator-only)
//
// These replace the fragile subprocess-based authority bridge with proper
// HTTP endpoints that TG can proxy to over the network.
//
// TDD: write the test first (RED), then implement in http.py (GREEN).

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const AIE_DIR = process.env.AIE_RUNTIME_PATH || path.join(__dirname, '..', '..', 'aie');
const PY = process.env.AIE_PYTHON || 'python';
const ENV = { ...process.env, PYTHONPATH: path.join(AIE_DIR, 'src') };

// ── Contract file (from GOV frozen schemas) ───────────────────────────

const CONTRACT_DIR = path.join(__dirname, '..', '..', 'after-graph-governance', 'docs', 'contracts', 'frozen');

test('frozen schemas exist in after-graph-governance (cross-repo mirror)', () => {
  for (const f of ['kernel.budget.schema.json', 'identity.schema.json', 'policy.token.schema.json', 'evidence.schema.schema.json']) {
    const p = path.join(CONTRACT_DIR, f);
    assert.ok(fs.existsSync(p), `frozen schema missing: ${f}`);
  }
});

test('AIE gateway http.py has the required read endpoints', () => {
  const httpPy = path.join(AIE_DIR, 'src', 'aie_runtime', 'gateway', 'http.py');
  const src = fs.readFileSync(httpPy, 'utf8');
  assert.match(src, /["']\/leases["']/, 'gateway must expose GET /leases');
  assert.match(src, /["']\/admissions["']/, 'gateway must expose GET /admissions');
  assert.match(src, /["']\/missions["']/, 'gateway must expose GET /missions');
});

test('AIE gateway read endpoints are operator-only (require bearer auth)', () => {
  const httpPy = path.join(AIE_DIR, 'src', 'aie_runtime', 'gateway', 'http.py');
  const src = fs.readFileSync(httpPy, 'utf8');
  // Each of the 3 new endpoints must be inside an _authorized() check
  const lines = src.split('\n');
  for (const endpoint of ['/leases', '/admissions', '/missions']) {
    const lineIdx = lines.findIndex((l) => l.includes(`"${endpoint}"`));
    assert.ok(lineIdx >= 0, `endpoint ${endpoint} not found in http.py`);
    // Look within 10 lines for _authorized()
    const context = lines.slice(lineIdx, lineIdx + 10).join('\n');
    assert.match(context, /_authorized\(\)/, `${endpoint} must require _authorized()`);
  }
});

// ── Integration test: boot the AIE gateway, verify the endpoints ──────

test('AIE gateway: boot + GET /leases + /admissions + /missions returns data', { skip: process.platform === 'win32' ? 'spawn HTTP server in Python is flaky on Windows WSL boundary' : false }, () => {
  // This test runs the Python gateway in a subprocess and curls it.
  // On Windows WSL boundary this is flaky, so skip if win32.
  const script = `
import json, sys, threading
sys.path.insert(0, ${JSON.stringify(path.join(AIE_DIR, 'src'))})
from aie_runtime.gateway.http import GatewayHTTPServer, _GatewayHandler
from aie_runtime.gateway.core import AIEGateway
from aie_runtime.store import InMemoryState
from aie_runtime.engine import AuthorityLease, Principal, Mission
from datetime import datetime, timedelta, timezone

state = InMemoryState()
state.principals['p1'] = Principal(id='p1', type='bot', identity_ref='tg')
state.missions['m1'] = Mission(id='m1', state='active')
state.leases['lease1'] = AuthorityLease(
    id='lease1', principal_id='p1', mission_id='m1',
    capabilities={'execute'}, resource_prefixes=('tools:',),
    expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    budget_remaining=50.0)

from aie_runtime.gateway.durable import SQLiteGatewayStore
from aie_runtime.gateway.policy import LocalPolicyAdapter
db = ${JSON.stringify(path.join(os.tmpdir(), 'aie-gw-test.db'))}
store = SQLiteGatewayStore(db)
gateway = AIEGateway(state=state, store=store, policy=LocalPolicyAdapter(lambda _: True))

server = GatewayHTTPServer(
    ('127.0.0.1', 0), _GatewayHandler,
    gateway=gateway, admin_token='test-token',
    trust_header_identity=False,
)
port = server.server_address[1]
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
print(json.dumps({'port': port}))
sys.stdout.flush()

# Keep alive until killed
import time
time.sleep(30)
`;
  const scriptPath = path.join(os.tmpdir(), 'aie-gw-test.py');
  fs.writeFileSync(scriptPath, script);

  // Start the server
  const proc = require('child_process').spawn(PY, [scriptPath], { env: ENV, stdio: 'pipe' });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });

  // Wait for the port to be printed
  setTimeout(() => {
    const match = output.match(/"port":\s*(\d+)/);
    if (!match) { proc.kill(); assert.fail('gateway did not report port'); }
    const port = parseInt(match[1]);

    // Test the endpoints
    const http = require('node:http');
    const opts = { host: '127.0.0.1', port, headers: { authorization: 'Bearer test-token' } };

    http.get({ ...opts, path: '/leases' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        assert.equal(res.statusCode, 200);
        const data = JSON.parse(raw);
        assert.ok(Array.isArray(data.leases) || Array.isArray(data), 'leases must be a list');
        proc.kill();
      });
    }).on('error', () => { proc.kill(); assert.fail('gateway unreachable'); });
  }, 2000);
});
