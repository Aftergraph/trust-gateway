'use strict';
// FS-E1 slice 2 — spawn a REAL gateway process scoped to a single tenant.
//
// Same spawn pattern as tests/fs-helpers.js (bin/gateway.js --dispatch,
// /healthz poll) but with per-tenant storage under an isolated tmp jail:
//   TG_DATA_DIR       <jail>/data                       (per-tenant data root)
//   TG_DB_FILE        <jail>/gateway.db                 (isolated tenant registry)
//   AUDIT_FILE        <jail>/data/tenants/<id>/audit.jsonl
//   APPROVALS_FILE    <jail>/data/tenants/<id>/approvals.json
//   BOTS_DIR          <jail>/bots                       (isolated jail root)
// The tenant row is pre-seeded into the child's OWN database by a short-lived
// `node -e` bootstrap (the parent's db.js connection is already bound), so
// token-prefix resolution ('tnt_<id>_…') works inside the child. close()
// kills the child and removes the jail. Zero deps beyond node builtins.
//
// Bot tokens are passed through VERBATIM — a spawned tenant gateway uses the
// full 'tnt_<id>_…' string as the bot token, so bearer auth stays an exact
// match and the tenant prefix is only a resolver claim (no auth rewiring).

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isValidTenantId } = require('./tenants');

const ROOT = path.join(__dirname, '..', '..'); // repo root (src/gateway → repo)

async function spawnTenantGateway({
  tenantId,
  port = null,
  tokens = {},
  caps = {},
  roles = {},
  env = {}, // extra env overrides ( TG_LLM_* etc.)
} = {}) {
  if (!isValidTenantId(tenantId)) {
    throw new Error('tenant-gateway: invalid tenant id (fail closed)');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1b-tenant-'));
  const dataDir = path.join(tmp, 'data');
  const dbFile = path.join(tmp, 'gateway.db');
  const botsDir = path.join(tmp, 'bots');
  const tenantRoot = path.join(dataDir, 'tenants', tenantId);
  const approvalsDir = path.join(tenantRoot, 'approvals');
  fs.mkdirSync(botsDir, { recursive: true });
  fs.mkdirSync(tenantRoot, { recursive: true });
  fs.mkdirSync(approvalsDir, { recursive: true });

  // Pre-seed the tenant row in the child's isolated DB (short-lived process —
  // the parent's db.js singleton is already bound to another file).
  const seedCode = `
    const { TenantStore } = require(${JSON.stringify(path.join(ROOT, 'src', 'gateway', 'tenants.js'))});
    const s = new TenantStore();
    s.ensureMain();
    const r = s.create({ name: ${JSON.stringify(tenantId)} });
    if (!r.ok || r.id !== ${JSON.stringify(tenantId)}) {
      console.error('tenant seed failed: ' + JSON.stringify(r));
      process.exit(1);
    }
  `;
  const baseEnv = Object.assign({}, process.env, {
    TG_DATA_DIR: dataDir,
    TG_DB_FILE: dbFile,
  });
  const seeded = spawnSync(process.execPath, ['-e', seedCode], { env: baseEnv, encoding: 'utf8' });
  if (seeded.status !== 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`tenant-gateway: seeding tenant '${tenantId}' failed: ${seeded.stderr || seeded.stdout}`);
  }

  const pairs = Object.entries(tokens).map(([n, t]) => `${n}:${t}`).join(',');
  const finalPort = port && Number(port) > 0 ? Number(port) : 20000 + Math.floor(Math.random() * 20000);
  const childEnv = Object.assign({}, baseEnv, {
    PORT: String(finalPort),
    BOT_TOKENS: pairs,
    BOT_CAPS: JSON.stringify(caps),
    BOT_ROLES: JSON.stringify(roles),
    // DB_FILE absent → JSONL audit chain (same gate as tests/fs-helpers.js);
    // audit + approvals live INSIDE the tenant-scoped dir.
    DB_FILE: path.join(tmp, 'chain-absent.db'),
    AUDIT_FILE: path.join(tenantRoot, 'audit.jsonl'),
    APPROVALS_FILE: path.join(approvalsDir, 'approvals.json'),
    BOTS_DIR: botsDir,
  }, env);

  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'gateway.js'), '--dispatch'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; });
  proc.stderr.on('data', (d) => { proc.log += d; });

  const base = `http://127.0.0.1:${finalPort}`;
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    try { proc.kill('SIGTERM'); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    const err = new Error(`tenant gateway '${tenantId}' did not become healthy on :${finalPort}\n${proc.log}`);
    err.log = proc.log;
    throw err;
  }

  return {
    base,
    port: finalPort,
    proc,
    tmp,
    tenantId,
    dataDir,
    dbFile,
    scopedDir: tenantRoot,
    async close() {
      if (!proc.killed) proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

module.exports = { spawnTenantGateway, ROOT };
