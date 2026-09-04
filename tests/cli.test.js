'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// W7 CLI/TUI tests — boots the real Gateway in-process on an ephemeral port
// and spawns bin/tg.js against it via child_process (execFile/spawn with an
// argument array; no shell string interpolation). Covers: every subcommand,
// --json, ANSI/plain output, exit codes 0/1, auth failures, tampered chain,
// and the piped-input TUI loop (including a real approve through the loop).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { Gateway } = require('../src/gateway/server');
const { GatewayClient } = require('../src/gateway/client');

const BIN = path.join(__dirname, '..', 'bin', 'tg.js');
const FORGE = 'tok-forge';
const ATLAS = 'tok-atlas';
const ESC = String.fromCharCode(27); // ANSI escape, built to avoid literal control bytes

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: FORGE, role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      atlas: { name: 'atlas', token: ATLAS, role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => {
      if (tool.startsWith('fs.read')) return { content: 'hello', tool, args: args ?? null };
      if (tool === 'shell.run') return { ran: true, cmd: String(args?.cmd ?? '') };
      return { ok: true, tool };
    },
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

// Shared live gateway for most tests (node:test runs tests within a file
// sequentially, so the approve/deny flows below can build on each other).
const server = http.createServer();
let baseUrl = null;

test.before(async () => {
  const gw = makeGateway();
  server.on('request', (req, res) => gw.handle(req, res));
  baseUrl = await listen(server);
});

test.after(() => new Promise((r) => server.close(r)));

function cliEnv({ token = FORGE, url = baseUrl, ...extra } = {}) {
  const env = { ...process.env, NO_COLOR: '1', ...extra };
  if (token === null) delete env.TG_TOKEN; else if (token !== undefined) env.TG_TOKEN = token;
  if (url === null) delete env.TG_URL; else if (url !== undefined) env.TG_URL = url;
  return env;
}

/** Run the CLI as a real child process. Returns { code, stdout, stderr }. */
function runCli(args, envOpts = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args], { env: cliEnv(envOpts), timeout: 25000 },
      (err, stdout, stderr) => {
        // err.code is the exit number when the process ran; only real spawn
        // failures (ENOENT etc.) reject.
        if (err && typeof err.code !== 'number') return reject(err);
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
  });
}

/** Pipe lines into the TUI child process and collect its output. */
function runTui(lines, envOpts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: cliEnv(envOpts), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

const parseJson = (s) => JSON.parse(s);

// ── help / usage / env errors ─────────────────────────────────────────────

test('help: --help exits 0 and lists all subcommands', async () => {
  const r = await runCli(['--help'], { token: undefined, url: undefined });
  assert.equal(r.code, 0);
  for (const c of ['status', 'verify', 'audit', 'pending', 'approve', 'deny', 'chat', 'search']) {
    assert.match(r.stdout, new RegExp(`\\b${c}\\b`), `usage mentions ${c}`);
  }
  assert.match(r.stdout, /TG_URL/);
});

test('missing TG_URL -> exit 1 with a clear error', async () => {
  const r = await runCli(['status'], { url: null });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TG_URL/);
});

test('missing TG_TOKEN -> exit 1 with a clear error', async () => {
  const r = await runCli(['verify'], { token: null });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TG_TOKEN/);
});

test('unknown command -> exit 1', async () => {
  const r = await runCli(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command/);
});

test('unknown flag -> exit 1', async () => {
  const r = await runCli(['status', '--nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag/);
});

test('connection refused -> exit 1, human error on stderr', async () => {
  const r = await runCli(['verify'], { url: 'http://127.0.0.1:9' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tg:/);
});

// ── status / verify ───────────────────────────────────────────────────────

test('status: human output reports ok + SEALED, exit 0', async () => {
  const r = await runCli(['status']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /health\s+✓ ok/);
  assert.match(r.stdout, /chain\s+✓ SEALED/);
  assert.match(r.stdout, /trust-gateway/);
});

test('status --json: single parseable document with chain+pending+stats', async () => {
  const r = await runCli(['status', '--json']);
  assert.equal(r.code, 0);
  const j = parseJson(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.health.ok, true);
  assert.equal(j.chain.ok, true);
  assert.ok(Array.isArray(j.pending));
  assert.equal(typeof j.pendingCount, 'number');
  assert.ok(j.stats && typeof j.stats.entries === 'number', 'stats snapshot present');
});

test('status with wrong token: health ok but chain unknown -> exit 1', async () => {
  const r = await runCli(['status', '--json'], { token: 'wrong-token' });
  assert.equal(r.code, 1);
  const j = parseJson(r.stdout);
  assert.equal(j.health.ok, true, '/healthz is unauthenticated');
  assert.equal(j.chain.error, 'unauthorized');
  assert.equal(j.ok, false);
});

test('verify: intact chain -> exit 0', async () => {
  const r = await runCli(['verify']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /audit chain intact/);
});

test('verify --json on a TAMPERED chain -> exit 1 (fail loudly)', async () => {
  const tmp = http.createServer();
  const gw = makeGateway();
  tmp.on('request', (req, res) => gw.handle(req, res));
  const url = await listen(tmp);
  const client = new GatewayClient({ baseUrl: url, token: FORGE });
  await client.action('fs.read:notes/a'); // some entries first
  // Tamper: rewrite a middle payload in memory — the seal no longer matches.
  const entries = gw.chain.entries;
  entries[Math.min(1, entries.length - 1)].payload = { type: 'evil', forged: true };
  const v = await runCli(['verify', '--json'], { url });
  assert.equal(v.code, 1);
  const j = parseJson(v.stdout);
  assert.equal(j.ok, false);
  assert.ok(typeof j.at === 'number' && j.reason, 'reports where it broke');
  const h = await runCli(['verify'], { url });
  assert.equal(h.code, 1);
  assert.match(h.stdout, /TAMPERED/);
  const s = await runCli(['status'], { url });
  assert.equal(s.code, 1);
  await new Promise((r) => tmp.close(r));
});

// ── pending / approve / deny (real RBAC, real chain) ──────────────────────

test('pending: empty queue -> friendly message, exit 0', async () => {
  const r = await runCli(['pending'], { token: ATLAS });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no pending approvals/);
});

let shellApprovalId = null;

test('approve flow: forge proposes shell.run, tg (atlas) approves it', async () => {
  const forge = new GatewayClient({ baseUrl, token: FORGE });
  const prop = await forge.action('shell.run', { cmd: 'echo hi' });
  assert.equal(prop.decision, 'needs_approval');
  shellApprovalId = prop.approvalId;

  const p = await runCli(['pending'], { token: ATLAS });
  assert.equal(p.code, 0);
  assert.ok(p.stdout.includes(shellApprovalId), 'id listed in human output');

  const pj = await runCli(['pending', '--json'], { token: ATLAS });
  assert.equal(pj.code, 0);
  assert.ok(pj.stdout.includes(shellApprovalId));

  const a = await runCli(['approve', shellApprovalId], { token: ATLAS });
  assert.equal(a.code, 0);
  assert.match(a.stdout, new RegExp(`approved ${shellApprovalId}`));
  assert.match(a.stdout, /ran/, 'dispatch result shown');

  const after = await runCli(['pending'], { token: ATLAS });
  assert.match(after.stdout, /no pending approvals/);
});

test('deny flow: second shell.run proposal gets denied', async () => {
  const forge = new GatewayClient({ baseUrl, token: FORGE });
  const prop = await forge.action('shell.run', { cmd: 'rm -rf /' });
  const d = await runCli(['deny', prop.approvalId], { token: ATLAS });
  assert.equal(d.code, 0);
  assert.match(d.stdout, new RegExp(`denied ${prop.approvalId}`));
});

test('approve with worker token -> exit 1 (operator_required)', async () => {
  const forge = new GatewayClient({ baseUrl, token: FORGE });
  const prop = await forge.action('shell.run', { cmd: 'ls' });
  const r = await runCli(['approve', prop.approvalId], { token: FORGE });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /operator_required/);
  // clean up so the queue stays empty for later tests
  await new GatewayClient({ baseUrl, token: ATLAS }).deny(prop.approvalId);
});

test('approve unknown id -> exit 1 (not_found)', async () => {
  const r = await runCli(['approve', 'apr_does_not_exist'], { token: ATLAS });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /not_found/);
});

test('approve without id -> exit 1 (usage)', async () => {
  const r = await runCli(['approve'], { token: ATLAS });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /usage/);
});

// ── audit / search ────────────────────────────────────────────────────────

test('audit: human table + --json entries, exit 0', async () => {
  const h = await runCli(['audit']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /seq\s+ts \(UTC\)/);
  assert.match(h.stdout, /action_decision|approval_requested/);

  const j = await runCli(['audit', '--json']);
  assert.equal(j.code, 0);
  const parsed = parseJson(j.stdout);
  assert.ok(Array.isArray(parsed.entries));
  assert.ok(parsed.entries.length >= 4, 'decisions above are on the record');
  assert.ok(parsed.entries.every((e) => typeof e.seq === 'number' && e.hash));
  assert.equal(parsed.verified.ok, true, 'audit carries chain verification');
});

test('audit --since N only shows newer entries', async () => {
  const all = parseJson((await runCli(['audit', '--json'])).stdout).entries;
  const since = all[all.length - 2].seq; // keep only the last entry
  const j = parseJson((await runCli(['audit', '--since', String(since), '--json'])).stdout);
  assert.ok(j.entries.every((e) => e.seq > since));
  assert.ok(j.entries.length < all.length);
});

test('search: finds the shell.run proposal in the audit chain', async () => {
  const j = await runCli(['search', 'shell.run', '--json']);
  assert.equal(j.code, 0);
  const parsed = parseJson(j.stdout);
  assert.ok(parsed.hits.length >= 1, 'at least one hit');
  assert.ok(parsed.hits.every((h) => JSON.stringify(h.payload).toLowerCase().includes('shell.run')));

  const h = await runCli(['search', 'shell.run', '-n', '3']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /hit/);
});

test('search with no matches -> exit 0, friendly empty', async () => {
  const r = await runCli(['search', 'zzz-nothing-matches-this']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no audit-chain hits/);
});

// ── chat ──────────────────────────────────────────────────────────────────

test('chat: read intent goes through policy and dispatch', async () => {
  const r = await runCli(['chat', 'read notes/x']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done:/);
  const j = parseJson((await runCli(['chat', 'read notes/x', '--json'])).stdout);
  assert.equal(typeof j.reply, 'string');
  assert.equal(j.actions[0].decision, 'allow');
});

test('chat: dangerous intent parks an approval (governed, not executed)', async () => {
  const r = await runCli(['chat', '--session', 'cli-test', 'run ls'], { token: ATLAS });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /needs_approval/);
  // clean up the parked approval
  const atlas = new GatewayClient({ baseUrl, token: ATLAS });
  const pend = await atlas.pending();
  for (const p of pend.pending || []) await atlas.deny(p.id);
});

test('chat without a message -> exit 1 (usage)', async () => {
  const r = await runCli(['chat']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /usage/);
});

// ── ANSI behavior ─────────────────────────────────────────────────────────

test('--color emits ANSI codes; NO_COLOR strips them', async () => {
  const c = await runCli(['verify', '--color']);
  assert.ok(c.stdout.includes(`${ESC}[`), 'ANSI escape present with --color');
  const n = await runCli(['verify'], { NO_COLOR: '1' });
  assert.ok(!n.stdout.includes(`${ESC}[`), 'no escapes under NO_COLOR');
  assert.equal(n.code, 0);
});

// ── TUI (piped commands against the live in-process gateway) ──────────────

test('TUI: banner + /help + /status + /quit, exit 0', async () => {
  const r = await runTui(['/help', '/status', '/quit']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /trust-gateway TUI/);
  assert.match(r.stdout, /\/approve <id>/);
  assert.match(r.stdout, /SEALED/);
  assert.match(r.stdout, /bye/);
});

test('TUI: bare text is treated as a chat message', async () => {
  const r = await runTui(['status', '/quit']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /chain:/, 'planner status reply');
});

test('TUI: unknown slash command is reported, loop survives, EOF exits 0', async () => {
  const r = await runTui(['/not-a-command', '/status']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /unknown command/);
  assert.match(r.stdout, /SEALED/);
});

test('TUI: /pending then /approve <id> resolves a real approval', async () => {
  const forge = new GatewayClient({ baseUrl, token: FORGE });
  const prop = await forge.action('shell.run', { cmd: 'echo tui' });
  const r = await runTui([
    '/pending',
    `/approve ${prop.approvalId}`,
    '/pending',
    '/quit',
  ], { token: ATLAS });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(prop.approvalId), 'pending table shows the id');
  assert.match(r.stdout, new RegExp(`approved ${prop.approvalId}`));
  const after = await forge.pending();
  assert.equal(after.pending.filter((p) => p.id === prop.approvalId).length, 0, 'resolved on the server');
});

test('TUI: /deny works and /chat returns a reply', async () => {
  const forge = new GatewayClient({ baseUrl, token: FORGE });
  const prop = await forge.action('shell.run', { cmd: 'echo nope' });
  const r = await runTui([
    `/deny ${prop.approvalId}`,
    '/chat help',
    '/quit',
  ], { token: ATLAS });
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`denied ${prop.approvalId}`));
  assert.match(r.stdout, /reply/, 'chat line printed');
});

test('TUI: missing TG_TOKEN -> exit 1 before the loop starts', async () => {
  const r = await runTui([], { token: null });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TG_TOKEN/);
});
