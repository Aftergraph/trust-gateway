'use strict';
// Conformance tier-A runner — ensures a gateway is up (reuses a healthy one
// on the port if present, else spawns its own), runs all 9 domain smoke
// files, prints a per-domain PASS/FAIL matrix, exits 0 only if all pass.
// Zero deps beyond node:child_process, node:http, node:fs, node:path.
//
// NEVER hardcode secrets here: env comes from data/gateway.env (gitignored)
// or the process environment only.
const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8800';
const PORT = new URL(GATEWAY_URL).port || 8800;
const GW_BIN = path.join(__dirname, '..', '..', 'bin', 'gateway.js');
const GW_DIR = path.join(__dirname, '..', '..');

// Environment sourced from data/gateway.env (never committed).
const envRaw = fs.existsSync(path.join(GW_DIR, 'data', 'gateway.env'))
  ? fs.readFileSync(path.join(GW_DIR, 'data', 'gateway.env'), 'utf8')
  : '';
function parseEnv(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^export\s+(\w+)=(.*)/);
    if (!m) continue;
    let val = m[2].replace(/^['"]|['"]$/g, '');
    out[m[1]] = val;
  }
  return out;
}
const envVars = parseEnv(envRaw);

const env = Object.assign({}, process.env, {
  BOT_TOKENS: envVars.TG_BOT_TOKENS || 'forge:fw-tok,atlas:at-tok',
  BOT_CAPS: envVars.TG_BOT_CAPS || '{"forge":["fs.read","fs.write:*"],"atlas":["*"]}',
  BOT_ROLES: envVars.TG_BOT_ROLES || '{"atlas":"operator","forge":"worker"}',
  PORT,
  TG_PORT: PORT,
  TG_LLM_BASE_URL: envVars.TG_LLM_BASE_URL || '',
  TG_LLM_KEY: envVars.TG_LLM_KEY || '',
  TG_LLM_MODEL: envVars.TG_LLM_MODEL || '',
  GATEWAY_URL,
  FORGE_TOKEN: (envVars.TG_BOT_TOKENS || '').split(',').find((p) => p.startsWith('forge:'))?.split(':')[1] || 'fw-tok',
  ATLAS_TOKEN: (envVars.TG_BOT_TOKENS || '').split(',').find((p) => p.startsWith('atlas:'))?.split(':')[1] || 'at-tok',
});

const DOMAINS = ['now', 'chat', 'work', 'agents', 'brain', 'output', 'control', 'connect', 'system'];

// ── gateway: reuse if healthy, else spawn ────────────────────────────────
let gwProc = null; // only set when WE spawned it (then we also kill it)
let gwCrashed = false;

function healthProbeOnce() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: Number(PORT), path: '/healthz', method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b).ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function spawnGateway() {
  gwProc = spawn('node', [GW_BIN, '--dispatch'], {
    cwd: GW_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gwProc.stdout.on('data', (d) => process.stderr.write(d));
  gwProc.stderr.on('data', (d) => process.stderr.write(d));
  gwProc.on('error', () => { gwCrashed = true; });
  gwProc.on('close', () => { gwCrashed = true; });
}

async function ensureGateway() {
  if (await healthProbeOnce()) {
    console.error('▲ conformance: reusing healthy gateway on :' + PORT);
    return;
  }
  spawnGateway();
  // poll /healthz until ready (max 20 s).
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (gwCrashed) throw new Error('spawned gateway crashed');
    if (await healthProbeOnce()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('gateway did not start within 20s');
}

// ── run each domain test ─────────────────────────────────────────────────
async function runDomain(name) {
  return new Promise((resolve) => {
    const fp = path.join(__dirname, name + '.test.js');
    if (!fs.existsSync(fp)) {
      return resolve({ name, pass: false, detail: 'file missing' });
    }
    const child = spawn('node', [fp], { cwd: GW_DIR, env });
    let err = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      resolve({ name, pass: code === 0, detail: code === 0 ? 'ok' : `exit ${code}`, stderr: err.trim().slice(-120) });
    });
    child.on('error', (e) => {
      resolve({ name, pass: false, detail: e.message });
    });
  });
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await ensureGateway();
  } catch (e) {
    console.error('FATAL gateway start:', e.message);
    if (gwProc) gwProc.kill('SIGTERM');
    process.exit(2);
  }

  const results = [];
  for (const d of DOMAINS) results.push(await runDomain(d));

  // ── matrix ────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   CONFORMANCE TIER-A — DOMAIN MATRIX    ║');
  console.log('╠══════════════════════════════════════════╣');
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const pad = r.name.padEnd(10);
    console.log(`║  ${pad} ${tag.padEnd(6)}${(r.detail || '').padEnd(16)}║`);
  }
  console.log('╠══════════════════════════════════════════╣');
  const allPass = results.every((r) => r.pass);
  const passCount = results.filter((r) => r.pass).length;
  const totalLabel = ('TOTAL: ' + passCount + '/' + DOMAINS.length).padEnd(10);
  const statusLabel = allPass ? 'ALL PASS'.padEnd(28) : 'SOME FAIL'.padEnd(28);
  console.log('║  ' + totalLabel + statusLabel + '║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (gwProc) gwProc.kill('SIGTERM'); // only kill what we spawned
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('RUNNER CRASH', e.message);
  if (gwProc) gwProc.kill('SIGTERM');
  process.exit(2);
});
