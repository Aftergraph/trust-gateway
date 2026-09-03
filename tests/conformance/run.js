'use strict';
// Conformance tier-A runner — spawns one gateway, runs all 9 domain
// smoke files, prints a per-domain PASS/FAIL matrix, exits 0 only if
// all pass.  Zero deps beyond node:child_process, node:http, node:fs,
// node:path, node:readline.
const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8800';
const PORT = new URL(GATEWAY_URL).port || 8800;
const GW_BIN = path.join(__dirname, '..', 'bin', 'gateway.js');
const GW_DIR = path.join(__dirname, '..');

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
  TG_LLM_BASE_URL: envVars.TG_LLM_BASE_URL || 'https://dialagram.me/router/v1',
  TG_LLM_KEY: envVars.TG_LLM_KEY || 'REPLACED-ROTATE',
  TG_LLM_MODEL: envVars.TG_LLM_MODEL || 'qwen-3.7-plus',
  GATEWAY_URL,
  FORGE_TOKEN: (envVars.TG_BOT_TOKENS || '').split(',').find((p) => p.startsWith('forge:'))?.split(':')[1] || 'fw-tok',
  ATLAS_TOKEN: (envVars.TG_BOT_TOKENS || '').split(',').find((p) => p.startsWith('atlas:'))?.split(':')[1] || 'at-tok',
});

const DOMAINS = ['now', 'chat', 'work', 'agents', 'brain', 'output', 'control', 'connect', 'system'];

// ── spawn gateway ────────────────────────────────────────────────────────
const gw = spawn('node', [GW_BIN, '--dispatch'], {
  cwd: GW_DIR,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let gwReady = false;
let gwCrashed = false;

gw.stdout.on('data', (d) => {
  const s = d.toString();
  if (s.includes('listening on')) gwReady = true;
  process.stderr.write(d);
});
gw.stderr.on('data', (d) => { process.stderr.write(d); });
gw.on('error', (e) => { gwCrashed = true; });
gw.on('close', () => { gwCrashed = true; });

// poll /healthz until ready (max 20 s).
function waitForGateway() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const poll = () => {
      if (gwCrashed) return reject(new Error('gateway process crashed'));
      if (Date.now() > deadline) return reject(new Error('gateway did not start within 20s'));
      const req = http.request({ host: '127.0.0.1', port: Number(PORT), path: '/healthz', method: 'GET' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            if (j.ok === true) { gwReady = true; resolve(); }
            else setTimeout(poll, 200);
          } catch { setTimeout(poll, 200); }
        });
      });
      req.on('error', () => setTimeout(poll, 200));
      req.end();
    };
    poll();
  });
}

// ── run each domain test ─────────────────────────────────────────────────
async function runDomain(name) {
  return new Promise((resolve) => {
    const fp = path.join(__dirname, name + '.test.js');
    if (!fs.existsSync(fp)) {
      return resolve({ name, pass: false, detail: 'file missing' });
    }
    const child = spawn('node', [fp], { cwd: GW_DIR, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
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
    await waitForGateway();
  } catch (e) {
    console.error('FATAL gateway start:', e.message);
    gw.kill('SIGTERM');
    process.exit(2);
  }

  const results = await Promise.all(DOMAINS.map(runDomain));

  // ── matrix ────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   CONFORMANCE TIER-A — DOMAIN MATRIX    ║');
  console.log('╠══════════════════════════════════════════╣');
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const pad = r.name.padEnd(10);
    console.log(`║  ${pad} ${tag.padEnd(6)}${r.detail.padEnd(16)}║`);
  }
  console.log('╠══════════════════════════════════════════╣');
  const allPass = results.every((r) => r.pass);
  const passCount = results.filter((r) => r.pass).length;
  const totalLabel = ('TOTAL: ' + passCount + '/' + DOMAINS.length).padEnd(10);
  const statusLabel = allPass ? 'ALL PASS'.padEnd(28) : 'SOME FAIL'.padEnd(28);
  console.log('║  ' + totalLabel + statusLabel + '║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── kill gateway ──────────────────────────────────────────────────────
  gw.kill('SIGTERM');

  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('RUNNER CRASH', e.message);
  gw.kill('SIGTERM');
  process.exit(2);
});