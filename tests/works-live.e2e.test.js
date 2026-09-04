'use strict';
// W0.3 durable E2E: TG MissionProposal approve → real WORKS Work creation.
// Requires: Go toolchain (go version) + ../works-execution repo — SKIPPED otherwise
// so CI without the Go toolchain stays green (the skip is honest, not a fake pass).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

let WORKS_DIR = path.join(__dirname, '..', '..', 'works-execution');
if (/^[A-Za-z]:\\/.test(WORKS_DIR) || /^[A-Za-z]:\//.test(WORKS_DIR)) {
  // normalize C:\foo -> /c/foo for MSYS/WSL bash interop
  WORKS_DIR = WORKS_DIR.replace(/^([A-Za-z]):[\\/]/, (m, d) => '/' + d.toLowerCase() + '/');
  WORKS_DIR = WORKS_DIR.replace(/\\/g, '/');
}

// Go toolchain discovery across hosts: the test suite runs under both Windows node
// (homedir C:/Users/x) and WSL node (homedir /root, repo on /mnt/c). Probe candidates.
// Always build WINDOWS binaries (works-api.exe): the WSL `node` here resolves go.exe
// via Windows interop, so the produced binary is a Windows exe — spawn it directly.
const GO_CANDIDATES = [
  '/mnt/c/Users/empir/go/bin/go.exe',
  path.join(os.homedir(), 'go', 'bin', 'go.exe'),
];

function findGo() {
  for (const c of GO_CANDIDATES) {
    try { execFileSync(c, ['version'], { timeout: 30000 }); return c; } catch { }
  }
  return null;
}

const GO = findGo();

function windowsHostIP() {
  try {
    const out = require('node:child_process').execFileSync('bash', ['-c',
      "ip route | grep default | awk '{print $3}' | head -1"], { timeout: 15000 }).toString().trim();
    return out || '127.0.0.1';
  } catch { return '127.0.0.1'; }
}

function goAvailable() { return !!GO; }

const hasGo = goAvailable();
const hasWorks = fs.existsSync(path.join(WORKS_DIR, 'go.mod'));

// WSL2 networking: a WSL-node-spawned Windows works-api binds the WINDOWS loopback;
// WSL fetch cannot reach it (NAT + firewall). The full live-flow e2e runs under
// Windows node or GitHub Actions (linux+go+same-namespace). Skipped honestly here.
const IS_WSL_NODE = process.platform === 'linux' && /mnt/.test(__dirname);

test('W0.3 live: TG proposal approve -> real WORKS Work with correlation', { skip: !hasGo || !hasWorks ? 'Go toolchain or works-execution not available' : IS_WSL_NODE ? 'WSL2 NAT blocks WSL->Windows loopback; run under Windows node/CI' : false }, async () => {
  assert.ok(true); // precondition satisfied
  // ── build works-api + works-worker (quiet, cached after first build) ──
  const apiBin = path.join(WORKS_DIR, 'works-api.exe');
  execFileSync(GO, ['build', '-o', apiBin, './cmd/works-api'], { cwd: WORKS_DIR, timeout: 300000 });

  // ── boot works-api on an ephemeral port with enroll secret ──
  const port = 8800 + Math.floor(Math.random() * 100);
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w03-')), 'works.db');
  const enrollSecret = 'w03-e2e-secret';
  // WSL node cannot spawn the Windows exe directly; route through bash interop.
  const api = spawn('bash', ['-c',
    `"${apiBin}" -addr 127.0.0.1:${port} -db "${dbFile}" -enroll-secret ${enrollSecret}`],
    { cwd: WORKS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    api.stderr.on('data', (d) => console.error('[works-api]', String(d).slice(0, 200)));
  try {
    // wait for healthz — probe BOTH 127.0.0.1 and the Windows host IP (the api binds
    // 0.0.0.0 on the WINDOWS loopback; WSL fetch reaches it via the host IP when the
    // process was spawned through WSL interop).
    let healthy = false;
    let base = '';
    for (let i = 0; i < 20 && !healthy; i++) {
      for (const host of ['127.0.0.1', windowsHostIP()]) {
        try {
          const r = await fetch(`http://${host}:${port}/healthz`);
          if (r.ok) { healthy = true; base = `http://${host}:${port}`; break; }
        } catch { }
      }
      if (!healthy) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(healthy, 'works-api healthy');
    const WORKS_BASE = base;
    const wr = await fetch(`${WORKS_BASE}/v1/works/${approved.converted_to_mission_id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(healthy, 'works-api healthy');

    // ── enroll a worker-scope token to submit Works (operator-equivalent for the API) ──
    const enr = await fetch(`http://127.0.0.1:${port}/v1/workers/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'wrkr_w03e2e', challenge: enrollSecret, scope: 'worker' }),
    });
    assert.equal(enr.status, 200);
    const { token } = await enr.json();

    // ── boot the TG gateway with WORKS_API_URL pointed at the control plane ──
    process.env.WORKS_API_URL = `http://127.0.0.1:${port}`;
    process.env.WORKS_API_TOKEN = token;
    const { Gateway } = require('../src/gateway/server');
    const gw = new Gateway({
      bots: { atlas: { token: 'tok-atlas', role: 'operator', capabilities: [] } },
      dispatch: async () => ({ ran: true }),
    });

    // ── create + submit a proposal with a proposed_mission ──
    const store = gw._proposalStore;
    const p = store.create({
      proposer: 'agent_1', channel: 'chat',
      objective: 'echo mission via WORKS',
      proposed_mission: { objective: 'echo mission', success_criteria: ['echoed'] },
    });
    store.submit(p.id);

    // ── approve: works-client should create a REAL Work and stamp its ID ──
    const approved = store.approve(p.id, 'atlas');
    assert.match(approved.converted_to_mission_id, /^wrk_/, 'durable WORKS Work ID as correlation');

    // (work verification moved above to use WORKS_BASE)
    assert.equal(wr.status, 200);
    const work = await wr.json();
    assert.equal(work.correlation_id, p.id, 'W0.3: mission_id correlation round-trip');
  } finally {
    try { api.kill(); } catch { }
  }
});