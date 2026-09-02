'use strict';
// v2 wave C mount: Playground — the safe in-app code lab (C6).
//
// Routes:
//   POST /v2/playground/run  {lang:'js'|'html', code, timeoutMs?, memMB?}
//                            bearer auth. JS runs via the jailed runner;
//                            HTML is never executed (preview token only).
//
// Executor (mount-declared, wave C addendum #1):
//   executors: [{ re: /^playground\.run:(js|html)$/, make: (gw) => fn }]
//   → the Gateway constructor auto-registers it, so the chat/LLM planner can
//     PROPOSE `playground.run:js` / `playground.run:html` through the normal
//     /v1/actions policy flow: playground.run:* is NOT in the policy table,
//     so classify() falls through to 'destructive' → decide() =
//     needs_approval → 202 + approval_requested, and the executor only runs
//     after a human operator approves. Both langs gated (js because arbitrary
//     code, html for symmetry + defense in depth). DECISION (documented):
//     only the executor is exposed to the tool namespace; the console panel
//     uses the HTTP mount directly (a human is already driving it), so chat
//     proposals go through approvals while the panel stays low-friction.
//
// Containment honesty (same posture as harness.js header — read it):
//   jail + scrubbed env + hard timeout IS the containment. We do NOT scan
//   the code for require('node:child_process') / require('node:fs') — any
//   such scan is trivially bypassable and would lie about safety. A scratch
//   node process running as the same user CAN read files outside the jail;
//   the mitigations we actually provide are:
//     • scratch file lives under data/bots/<bot>/playground/ via the jail-safe
//       resolver (bot name validated; no traversal in the path we build)
//     • child cwd = jail dir, argv = [node, --max-old-space-size=N, scratch]
//       (never a shell string), stdout/stderr capped at 8 KB tails
//     • env scrubbed to PATH/HOME/NODE_ENV ONLY — no bot tokens, no API keys,
//       no TG_* secrets reach the child
//     • hard timeout → SIGKILL
//   Residual, stated plainly: fs/network access is NOT blocked by this module.
//   Network is *discouraged* via TG_NO_NET=1 in the child env (a hint for
//   well-behaved code), and deploy/cloud.md (wave C C5) documents adding
//   unshare/network namespaces at the container layer — that hardened
//   container is the real boundary, later slice.
//
// Audit (chain hygiene): playground_run carries {bot, lang, bytes, exitCode,
//   timedOut} — NEVER the code content and never stdout bodies.

const path = require('node:path');
const { send, readBody } = require('../server');
const { runSnippet, MAX_CODE_BYTES } = require('../playground');

const runners = new WeakMap(); // gw → runner fn bound to that gateway's botsDir

function getRunner(gw) {
  let r = runners.get(gw);
  if (!r) {
    const botsDir = gw.botsDir
      || process.env.BOTS_DIR
      || path.join(__dirname, '..', '..', 'data', 'bots');
    r = makePlaygroundRunner(botsDir, gw); // gw captured so audits are emitted
    runners.set(gw, r);
  }
  return r;
}

// Executor factory (same shape as 55-harness.js): the server calls executors
// unbound as fn(bot, tool, args), so gw is captured in the closure here.
function makePlaygroundRunner(botsDir, gw) {
  return async function playgroundExecutor(botName, tool, args) {
    const m = /^playground\.run:(js|html)$/.exec(tool);
    if (!m) return { ok: false, error: 'bad_tool' };
    const lang = m[1];
    const code = args && typeof args.code === 'string' ? args.code : '';
    if (!code) return { ok: false, error: 'missing_code' };
    const out = await runSnippet({ bot: botName, lang, code, botsDir });
    if (out.ok) {
      // Executor-path audit: metrics only, never code content (gw may be
      // undefined when the factory was constructed without one — tests).
      if (gw && typeof gw._audit === 'function') {
        gw._audit({
          type: 'playground_run',
          bot: botName,
          lang,
          bytes: Buffer.byteLength(code, 'utf8'),
          exitCode: out.exitCode === undefined ? null : out.exitCode,
          timedOut: out.timedOut === true,
        });
      }
    }
    return out;
  };
}

// ── POST /v2/playground/run ─────────────────────────────────────────────
async function handle(gw, req, res, ctx) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const bot = ctx.bot;
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'invalid_json' });
  }
  const lang = body && body.lang;
  const code = body && typeof body.code === 'string' ? body.code : null;
  if (lang !== 'js' && lang !== 'html') return send(res, 400, { error: 'bad_lang' });
  if (code === null) return send(res, 400, { error: 'missing_code' });
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return send(res, 400, { error: 'code_too_large', limit: MAX_CODE_BYTES });
  }
  const runner = getRunner(gw);
  const opts = {};
  if (body.timeoutMs !== undefined) opts.timeoutMs = Number(body.timeoutMs) || undefined;
  if (body.memMB !== undefined) opts.memMB = Number(body.memMB) || undefined;
  const out = await runner(bot.name, `playground.run:${lang}`, { code, ...opts });
  if (!out.ok) {
    const status = out.error === 'code_too_large' ? 400
      : out.error === 'bad_lang' ? 400
      : out.error === 'escapes_jail' ? 403
      : 500;
    return send(res, status, out);
  }
  return send(res, 200, { ok: true, lang, result: out });
}

module.exports = {
  name: 'v2-playground',
  method: 'POST',
  path: /^\/v2\/playground\/run$/,
  auth: 'bearer',
  handle,
  executors: [{
    re: /^playground\.run:(js|html)$/,
    make: (gw) => makePlaygroundRunner(gw.botsDir
      || process.env.BOTS_DIR
      || path.join(__dirname, '..', '..', 'data', 'bots'), gw),
  }],
  // exported for tests
  makePlaygroundRunner,
  getRunner,
  MAX_CODE_BYTES,
};