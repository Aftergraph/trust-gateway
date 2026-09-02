'use strict';
// v2 wave C — Playground runner: the safe in-app code lab (C6).
//
// runSnippet({bot, lang, code, timeoutMs, memMB, botsDir}):
//   lang 'js'  → write the snippet to the CALLER BOT JAIL
//                (data/bots/<bot>/playground/scratch-<ts>.js via the
//                jail-safe resolver), spawn process.execPath with
//                execArgv/execFile argv ['--max-old-space-size=' + memMB,
//                scratchPath], cwd = jail dir, hard timeout → SIGKILL,
//                env scrubbed to PATH/HOME/NODE_ENV (+ TG_NO_NET=1 hint),
//                stdout/stderr tails capped at 8 KB.
//   lang 'html' → NO execution. Returns { ok, preview: 'sandboxed' } —
//                the escaped-preview token the iframe panel consumes.
//
// CONTAINMENT HONESTY (read before trusting this module — same posture as
// harness.js): jail + scrubbed env + hard timeout IS the containment. We
// deliberately do NOT scan code for require('node:child_process') or
// require('node:fs') — any such lexical scan is trivially bypassable
// (string concat, dynamic import, Function constructor) and would falsely
// advertise safety. Residual risk, stated plainly: the scratch process runs
// as the same OS user as the gateway, so code in the jail CAN require fs and
// read/write outside the jail, and CAN open sockets — network is NOT blocked
// by this module. Mitigations that are real: jail-resolved scratch path
// (bot-name + traversal validated), shell-free spawn, 8 KB output tails,
// SIGKILL timeout, env scrub (no tokens/secrets reach the child),
// TG_NO_NET=1 as a hint for well-behaved code. The real boundary is a
// hardened container (unshare / network namespace) — deploy/cloud.md (C5)
// documents that; it is a later slice. Code length ≤ MAX_CODE_BYTES (8000).
//
// FORBIDDEN and not done: eval() of model output — the model proposes code
// only through the executor policy flow (unknown tool → destructive →
// needs_approval) and it always runs as a separate node process in the jail,
// never via eval in the gateway process.
//
// Audit hygiene: callers emit playground_run {bot, lang, bytes, exitCode,
//   timedOut} — never code content, never stdout bodies.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_CODE_BYTES = 8000;   // code length cap (mirrored client-side)
const TAIL_BYTES = 8 * 1024;   // stdout/stderr tails, 8 KB each
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MEM_MB = 64;
const PG_DIR = 'playground';

function tryRealpath(p) {
  try { return fs.realpathSync(p); } catch { return undefined; }
}

// Jail-safe resolve: reject absolute targets and any '..' segment, then
// verify the realpath (or deepest existing ancestor) stays inside realRoot.
// Same semantics as harness.js jailResolve — throws ESCAPES_JAIL.
function jailResolve(target, rootDir) {
  if (typeof target !== 'string' || target.length === 0) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  if (path.isAbsolute(target)) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  if (target.split(path.sep).some((p) => p === '..')) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  const resolved = path.resolve(rootDir, target);
  const realRoot = tryRealpath(rootDir);
  const realTarget = tryRealpath(resolved);
  if (realTarget !== undefined) {
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
    }
    return realTarget;
  }
  let p = path.dirname(resolved);
  let realAncestor;
  let ancestorPath; // the (possibly unresolved) ancestor that realAncestor mirrors
  while (p !== rootDir && p !== path.parse(p).dir) {
    realAncestor = tryRealpath(p);
    if (realAncestor !== undefined) { ancestorPath = p; break; }
    p = path.dirname(p);
  }
  if (realAncestor === undefined) {
    // No existing ancestor found — fall back to the jail root itself.
    // rootDir may not exist on disk yet (e.g. fresh temp dir), so we
    // use the logical root for the relative computation.
    realAncestor = path.resolve(rootDir);
    ancestorPath = rootDir;
  }
  // Join the realpath of the deepest existing ancestor with the remainder
  // RELATIVE TO THAT ANCESTOR (not relative to rootDir — a nested dir may
  // already exist and must not be double-appended).
  const tailRel = path.relative(ancestorPath, resolved);
  const canonical = path.join(realAncestor, tailRel);
  // Containment check: use the logical root (ancestorPath) when realRoot
  // is unavailable (dir doesn't exist yet), otherwise use realRoot.
  const containmentRoot = realRoot || path.resolve(rootDir);
  if (canonical !== containmentRoot && !canonical.startsWith(containmentRoot + path.sep)) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  return canonical;
}

function tail(s) {
  return s.length <= TAIL_BYTES ? s : s.slice(-TAIL_BYTES);
}

function validBot(bot) {
  return typeof bot === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(bot) && !bot.startsWith('.');
}

/**
 * Run a playground snippet.
 * @returns {Promise<{ok:boolean, lang:string, exitCode:number|null,
 *   timedOut:boolean, stdout:string, stderr:string, durationMs:number,
 *   preview?:string, error?:string}>}
 */
async function runSnippet({
  bot, lang, code,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  memMB = DEFAULT_MEM_MB,
  botsDir,
} = {}) {
  if (!validBot(bot)) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  if (lang !== 'js' && lang !== 'html') return { ok: false, lang, error: 'bad_lang' };
  if (typeof code !== 'string') return { ok: false, lang, error: 'missing_code' };
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_CODE_BYTES) {
    return { ok: false, lang, error: 'code_too_large', limit: MAX_CODE_BYTES };
  }
  if (botsDir === undefined || botsDir === null) {
    throw new Error('runSnippet requires botsDir');
  }

  // HTML: no execution — escaped preview token only.
  if (lang === 'html') {
    return { ok: true, lang: 'html', preview: 'sandboxed', exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0 };
  }

  const rootDir = tryRealpath(path.resolve(botsDir));
  if (!rootDir) {
    fs.mkdirSync(path.resolve(botsDir), { recursive: true });
  }
  const realRoot = tryRealpath(path.resolve(botsDir)) || path.resolve(botsDir);
  const botRoot = jailResolve(String(bot), realRoot);
  fs.mkdirSync(botRoot, { recursive: true });
  const pgDir = jailResolve(PG_DIR, botRoot);
  fs.mkdirSync(pgDir, { recursive: true });
  const ts = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  // jailResolve resolves against the jail root, so give it the bot-relative
  // path (playground/scratch-<ts>.js) — same pattern as harness.js.
  const scratchPath = jailResolve(`${PG_DIR}/scratch-${ts}.js`, botRoot);
  // Defense in depth: the resolved scratch path must be under botsDir realpath.
  const realScratch = tryRealpath(scratchPath) || scratchPath;
  if (realScratch !== realRoot && !realScratch.startsWith(realRoot + path.sep)) {
    throw Object.assign(new Error('escapes_jail'), { code: 'ESCAPES_JAIL' });
  }
  fs.writeFileSync(scratchPath, code, { encoding: 'utf8', mode: 0o600 });

  // Env scrub: PATH/HOME/NODE_ENV ONLY (+ TG_NO_NET hint). No tokens, no
  // API keys, no inherited TG_* secrets. PATH is intentionally present
  // (node itself needs it for spawn lookups) — secrets are what's gone.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    NODE_ENV: 'production',
    TG_NO_NET: '1', // hint only — see containment honesty above
  };

  const cwd = pgDir;
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const mem = Math.max(8, Number(memMB) || DEFAULT_MEM_MB);

  return new Promise((resolve) => {
    const started = Date.now();
    // NEVER a shell string: argv array with the mem flag as an execArgv-style
    // leading argument (the task spec: execArgv ['--max-old-space-size='+memMB,
    // scratchPath] — spawn() applies execArgv the same way for a plain script).
    const child = spawn(process.execPath, ['--max-old-space-size=' + mem, scratchPath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({
        ok: true, lang: 'js', exitCode: null, timedOut: true,
        stdout: tail(out), stderr: tail(err), durationMs: Date.now() - started,
      });
    }, timeout);

    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: true, lang: 'js', exitCode: 1, timedOut: false,
        stdout: tail(out), stderr: tail(`${err}${err ? '\n' : ''}${e.message}`),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: true, lang: 'js', exitCode, timedOut: false,
        stdout: tail(out), stderr: tail(err), durationMs: Date.now() - started,
      });
    });
  });
}

module.exports = {
  runSnippet,
  jailResolve,
  MAX_CODE_BYTES,
  TAIL_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MEM_MB,
  PG_DIR,
};