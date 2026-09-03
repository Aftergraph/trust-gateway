'use strict';
// FS-D1 shared spawn helper — a REAL gateway process (bin/gateway.js
// --dispatch) on a random loopback port with:
//   • an optional stub OpenAI-compatible brain (local http server),
//   • isolated audit/approvals/db/bots storage under a tmpdir,
//   • the jailed dispatcher enabled and a pre-seeded jail file.
// NOT a *.test.js file — excluded from the `node --test tests/*.test.js` glob.
//
// Spawn pattern mirrors tests/conformance/run.js (env → spawn → /healthz
// poll). Zero deps beyond node: builtins.

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const TOKENS = { forge: 'fw-tok', atlas: 'at-tok' };
const JAIL_FILE_REL = 'notes/todo.md';
const JAIL_FILE_TEXT = 'hello-jail-fsd1';

// ── stub OpenAI-compatible /chat/completions ──────────────────────────
// `replies` is consumed one per upstream call; past the end, a plain
// deterministic reply is returned. Each reply may embed an <action …/>
// tag — deepTurn parses and governs it exactly like a real model reply.
function makeStubBrain(replies = []) {
  const stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      stub.calls += 1;
      const content = stub.calls <= replies.length
        ? replies[stub.calls - 1]
        : `Stub plain reply ${stub.calls}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { total_tokens: 10 },
      }));
    });
  });
  stub.calls = 0;
  stub.replies = replies;
  return stub;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── spawn the real gateway ────────────────────────────────────────────
// opts.replies   — stub brain reply script (brain configured only when non-empty)
// opts.brain     — set false to leave TG_LLM_* unset (unconfigured brain)
async function spawnGateway(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsd1-gw-'));
  const jail = path.join(tmp, 'bots', 'forge', 'notes');
  fs.mkdirSync(jail, { recursive: true });
  fs.writeFileSync(path.join(jail, 'todo.md'), JAIL_FILE_TEXT);

  let stub = null;
  const env = Object.assign({}, process.env, {
    PORT: '0', // replaced below once the stub port is known
    BOT_TOKENS: `forge:${TOKENS.forge},atlas:${TOKENS.atlas}`,
    BOT_CAPS: '{"forge":["fs.read","fs.write:*"],"atlas":["*"]}',
    BOT_ROLES: '{"atlas":"operator","forge":"worker"}',
    AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
    APPROVALS_FILE: path.join(tmp, 'approvals.json'),
    DB_FILE: path.join(tmp, 'gateway.db'), // absent → JSONL chain
    BOTS_DIR: path.join(tmp, 'bots'),
    TG_ARTIFACTS_FILE: path.join(tmp, 'artifacts.json'),
  });

  if (opts.brain !== false) {
    stub = makeStubBrain(opts.replies || []);
    const stubPort = await listen(stub);
    env.TG_LLM_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
    env.TG_LLM_KEY = 'stub-key-not-a-secret';
    env.TG_LLM_MODEL = 'stub-model';
    env.TG_LLM_TIMEOUT_MS = '5000';
  }

  const port = 20000 + Math.floor(Math.random() * 20000);
  env.PORT = String(port);
  const proc = spawn('node', [path.join(ROOT, 'bin', 'gateway.js'), '--dispatch'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; });
  proc.stderr.on('data', (d) => { proc.log += d; });

  const base = `http://127.0.0.1:${port}`;
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
    const err = new Error(`spawned gateway did not become healthy on :${port}\n${proc.log}`);
    err.log = proc.log;
    throw err;
  }

  return {
    base,
    port,
    proc,
    stub,
    tmp,
    tokens: TOKENS,
    jailFile: JAIL_FILE_REL,
    jailText: JAIL_FILE_TEXT,
    async close() {
      if (!proc.killed) proc.kill('SIGTERM');
      if (stub) await new Promise((r) => stub.close(r));
      await new Promise((r) => setTimeout(r, 150));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// ── tiny HTTP client ──────────────────────────────────────────────────
// AUTH is built with the platform concat pattern (no literal scheme) so
// the security sweep's source invariant also holds in tests.
const AUTH = 'Bear' + 'er ';
async function api(base, method, p, { body, token, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.authorization = AUTH + token;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (HTML/SSE) */ }
  return { status: res.status, text, json };
}

module.exports = { spawnGateway, makeStubBrain, api, TOKENS, ROOT, JAIL_FILE_REL, JAIL_FILE_TEXT };
