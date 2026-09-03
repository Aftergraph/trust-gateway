'use strict';
// FS-C2 mount: harness v2 — project model with a jailed build/run loop.
//
//   POST /v2/harness2/projects        {name, files:{relPath:content}, entry?,
//                                      skills?, requiresApproval?} → 201
//                                     (256 KB total source cap; path
//                                      traversal keys rejected; id = slug of
//                                      name; 409 when the slug already exists)
//   GET  /v2/harness2/projects        → {count, projects:[manifest+fileCount]}
//   GET  /v2/harness2/projects/:id    → {project} | 404
//   POST /v2/harness2/projects/:id/build → clean files/→jail/ copy
//   POST /v2/harness2/projects/:id/run   → jailed `node <entry>` run
//
// RBAC on POST /build and POST /run (and on create): operator role, cap
// 'harness.run', or wildcard '*'. Everyone else 403 + approval_forbidden
// audit (existing vocabulary, no new type).
//
// APPROVAL GATE (documented honestly):
// When the project manifest declares requiresApproval=true, POST /run does
// NOT execute. It parks a request in gw.approvals (tool `harness2.run:<id>`)
// and returns 202 {decision:'needs_approval', approvalId}. After an operator
// approves via the standard /v1/approvals/:id/approve flow, the gateway
// executes the parked tool through the harness2.run executor exported below
// (wave C convention: executors:[{re, make(gw)}] — bin/gateway.js is never
// touched).
//
// HONEST LIMITATION — the jail is NOT a real sandbox: it is a directory under
// the gateway user's own account with process discipline only (no shell,
// scrubbed env PATH/HOME/NODE_ENV, 10 s SIGKILL, 8 KB output tails). A
// malicious entry can still reach anything the gateway user can. This is the
// same limitation harness.js (wave B) already acknowledges; requiresApproval
// exists precisely so a human decides before any declared-risk project runs.
// FS-F3 adds an OPTIONAL OS-level layer behind TG_SANDBOX=1 (bwrap/unshare
// with honest detection + graceful fallback, see sandbox.js) — off by
// default, and a fallback to the unwrapped run is the documented norm, not
// an error state.
//
// Transparency rows (TRANSPARENCY.md 106-107): the chain carries
// harness2_project_created {id, fileCount} and harness2_run
// {bot, id, ok, exitCode, durationMs} — never file contents, never
// stdout/stderr.

const path = require('node:path');
const { send, readBody } = require('../server');
const { makeHarness2, ID_RE, MAX_TOTAL_BYTES } = require('../harness2');

// Per-gateway harness instance, bound to a resolved data dir. Resolution
// order (at first use): HARNESS2_DIR env → sibling of gw.botsDir (production:
// data/bots → data/harness2) → repo data/harness2. Tests isolate by passing
// botsDir under a tmpdir to the Gateway constructor.
const instances = new WeakMap(); // gw -> { key, h }

function dataDirFor(gw) {
  if (process.env.HARNESS2_DIR) return process.env.HARNESS2_DIR;
  if (gw && gw.botsDir) return path.join(path.dirname(path.resolve(gw.botsDir)), 'harness2');
  return path.resolve(__dirname, '..', '..', '..', 'data', 'harness2');
}

function getHarness2(gw) {
  const key = dataDirFor(gw);
  const rec = instances.get(gw);
  if (rec && rec.key === key) return rec.h;
  // FS-F3: sandbox audit rows ride the same chain, one per run — method is
  // 'bwrap' | 'unshare' | 'none'; a runtime wrap failure additionally emits
  // sandbox_fallback before the unwrapped retry. No argv, no paths, no
  // file contents — id and method only.
  const h = makeHarness2({
    dataDir: key,
    onSandboxUsed: (info) => gw._audit({ type: 'sandbox_used', id: info.id, method: info.method }),
    onSandboxFallback: (info) => gw._audit({
      type: 'sandbox_fallback', id: info.id, method: info.method, reason: String(info.reason || 'unknown').slice(0, 60),
    }),
  });
  instances.set(gw, { key, h });
  return h;
}

// RBAC: operator, capability 'harness.run', or wildcard '*'.
function canHarnessRun(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('harness.run') || caps.includes('*');
}

// Run + ONE transparency row (exit code and duration only, never output).
// Emitted only for real executions — a project that can't run (not found,
// not built) leaves no harness2_run row behind.
async function runAndAudit(gw, h, id) {
  const run = await h.runProject(id);
  if (run.ok === false) return run;
  const ok = run.timedOut === true || run.exitCode === 0;
  gw._audit({
    type: 'harness2_run',
    id: String(id),
    ok,
    exitCode: run.exitCode === undefined ? null : run.exitCode,
    durationMs: run.durationMs === undefined ? null : run.durationMs,
  });
  return run;
}

// Executor for the approval flow: after an operator approves the parked
// `harness2.run:<id>` decision, Gateway._run dispatches here.
function makeHarness2RunExecutor(gw) {
  const h = getHarness2(gw);
  return async function harness2RunExecutor(_botName, tool) {
    const m = /^harness2\.run:(.+)$/.exec(tool);
    if (!m) return { ok: false, error: 'bad_tool' };
    const id = m[1];
    if (!ID_RE.test(id)) return { ok: false, error: 'bad_id' };
    return runAndAudit(gw, h, id);
  };
}

module.exports = {
  name: 'v2-harness2',
  method: '*',
  path: /^\/v2\/harness2(?:\/projects(?:\/([^/]+))?(?:\/(build|run))?)?$/,
  auth: 'bearer',
  MAX_TOTAL_BYTES,
  makeHarness2RunExecutor,
  getHarness2,
  canHarnessRun,
  runAndAudit,
  executors: [
    { re: /^harness2\.run:/, make: makeHarness2RunExecutor },
  ],
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot; // auth:'bearer' — server already rejected otherwise
    const h = getHarness2(gw);
    const seg = ctx.params.matches[1] || null;
    const action = ctx.params.matches[2] || null;
    const send403 = (tool) => {
      gw._audit({ type: 'approval_forbidden', bot: bot.name, tool });
      return send(res, 403, { error: 'operator_or_harness_run_required' });
    };

    // ── GET /v2/harness2/projects — list (any authed identity) ──
    // ── POST /v2/harness2/projects — create ─────────────────────
    if (!seg) {
      if (req.method === 'GET') {
        const projects = h.listProjects();
        return send(res, 200, { count: projects.length, projects });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (!canHarnessRun(bot)) return send403('harness2.create');
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        // body_too_large or invalid JSON — the socket may already be dying,
        // so this is a best-effort 400/413 answer.
        return send(res, 400, { error: 'invalid_json_or_body_too_large' });
      }
      const out = h.createProject(body || {});
      if (!out.ok) {
        const status = out.error === 'size_cap' ? 413
          : out.error === 'id_exists' ? 409
          : 400;
        return send(res, status, { error: out.error, totalBytes: out.totalBytes, cap: out.cap, path: out.path });
      }
      gw._audit({ type: 'harness2_project_created', id: out.project.id, fileCount: out.fileCount });
      return send(res, 201, {
        ok: true, id: out.project.id, project: out.project,
        fileCount: out.fileCount, warnings: out.warnings,
      });
    }

    const id = seg;

    // ── POST /v2/harness2/projects/:id/build|run ────────────────
    if (action) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad_id' });
      const tool = `harness2.${action}:${id}`;
      if (!canHarnessRun(bot)) return send403(tool);

      if (action === 'build') {
        const out = h.buildProject(id);
        if (!out.ok) {
          const status = out.error === 'not_found' ? 404 : 400;
          return send(res, status, { ok: false, error: out.error, errors: out.errors });
        }
        return send(res, 200, out);
      }

      // action === 'run'
      const manifest = h.getProject(id);
      if (!manifest) return send(res, 404, { error: 'not_found' });
      // Approval gate: a project that declares requiresApproval NEVER runs
      // directly — the request is parked for a human decision instead.
      if (manifest.requiresApproval === true) {
        const approval = gw.approvals.request({
          bot,
          tool: `harness2.run:${id}`,
          args: {},
          reason: 'harness2 manifest requiresApproval=true — jailed run needs a human decision',
        });
        gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: bot.name, tool: `harness2.run:${id}` });
        return send(res, 202, {
          decision: 'needs_approval',
          approvalId: approval.id,
          tool: `harness2.run:${id}`,
        });
      }
      const run = await runAndAudit(gw, h, id);
      if (run.ok === false) {
        const status = run.error === 'not_found' ? 404 : (run.error === 'not_built' ? 409 : 400);
        return send(res, status, run);
      }
      return send(res, 200, run);
    }

    // ── GET /v2/harness2/projects/:id — read one ────────────────
    if (req.method === 'GET') {
      if (!ID_RE.test(id)) return send(res, 400, { error: 'bad_id' });
      const project = h.getProject(id);
      if (!project) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { project });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
