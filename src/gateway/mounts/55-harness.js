'use strict';
// v2 wave B mount: backend harness + worktree trees.
//
// The executor functions are exported as FACTORIES so bin/gateway.js can
// register them via gw.registerExecutor(re, makeXExecutor(gw)) behind the
// normal dispatch policy (unknown tools classify destructive → approval →
// executor runs after approval). The server calls executors unbound
// (exec(bot, tool, args)), so the gateway reference must be captured in the
// closure. Also serves:
//
//   GET /v2/trees  — list this bot's worktree snapshots (bearer auth)
//
// Audit: the server's action_executed flow covers executor calls. On
// harness.run we additionally emit ONE gw._audit passthrough of type
// 'harness_result' {bot, tool, exitCode} — no stdout content in the audit;
// output goes to the caller's HTTP response, not the chain. Artifact hook:
// creating a W5 'report' artifact with the run output summary is
// intentionally NOT done here — the executor runs behind policy without a
// request context and the artifacts store is reached via its own mount;
// the result is returned to the authed caller instead. Documented skip.

const path = require('node:path');
const { makeHarness } = require('../harness');

const harnesses = new WeakMap(); // gw -> harness (single instance per gateway)
const harnessDirs = new WeakMap(); // gw -> botsDir bound at executor registration

// botsDir is bound at executor-registration time (bin/gateway.js passes the
// same resolved botsDir it gives the dispatcher) — NOT read from env at first
// use, which would silently resolve against cwd in tests and mounts.
function getHarness(gw, botsDir) {
  let h = harnesses.get(gw);
  if (!h) {
    h = makeHarness({
      botsDir: botsDir
        || process.env.BOTS_DIR
        || path.join(__dirname, '..', '..', 'data', 'bots'),
    });
    harnesses.set(gw, h);
    if (botsDir) harnessDirs.set(gw, botsDir);
  }
  return h;
}

// ── executor: harness.build / harness.run ─────────────────────
function makeHarnessExecutor(botsDir, gw) {
  const h = getHarness(gw, botsDir);
  return async function harnessExecutor(botName, tool, args) {
    const m = /^harness\.(build|run):(.+)$/.exec(tool);
    if (!m) return { ok: false, error: 'bad_tool' };
    const name = m[2];

    if (tool.startsWith('harness.build:')) {
      const files = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
      const out = await h.build(botName, name, files);
      if (out.ok) {
        gw._audit({ type: 'harness_build', bot: botName, tool, app: out.name, files: out.paths.length });
      }
      return out;
    }

    // harness.run:<name>
    const run = await h.run(botName, name);
    // ONE passthrough audit entry per run — exit code only, never stdout.
    gw._audit({
      type: 'harness_result',
      bot: botName,
      tool,
      exitCode: run.exitCode === undefined ? null : run.exitCode,
      timedOut: run.timedOut === true,
    });
    return run;
  };
}

// ── executor: worktree.snapshot / worktree.remove / worktree.list ──
function makeWorktreeExecutor(botsDir, gw) {
  const h = getHarness(gw, botsDir);
  return async function worktreeExecutor(botName, tool) {
    if (tool === 'worktree.list') {
      const trees = h.listTrees(botName);
      return { ok: true, trees };
    }
    const m = /^worktree\.(snapshot|remove):(.+)$/.exec(tool);
    if (!m) return { ok: false, error: 'bad_tool' };
    const name = m[2];

    if (tool.startsWith('worktree.snapshot:')) {
      const out = await h.snapshot(botName, name);
      if (out.ok) {
        gw._audit({ type: 'worktree_snapshot', bot: botName, tool, tree: out.id, files: out.files });
      }
      return out;
    }
    // worktree.remove:<id>
    const out = await h.remove(botName, name);
    if (out.ok) {
      gw._audit({ type: 'worktree_remove', bot: botName, tool, tree: out.id });
    }
    return out;
  };
}

module.exports = {
  name: 'v2-harness',
  method: 'GET',
  path: /^\/v2\/trees$/,
  auth: 'bearer',
  makeHarnessExecutor,
  makeWorktreeExecutor,
  getHarness,
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    const { send } = require('../server');
    let trees;
    try {
      trees = getHarness(gw, harnessDirs.get(gw)).listTrees(bot.name);
    } catch (e) {
      if (String(e && e.message).includes('escapes_jail')) {
        gw._audit({ type: 'auth_rejected', path: ctx.url.pathname });
        return send(res, 403, { error: 'escapes_jail' });
      }
      return send(res, 500, { error: 'internal_error' });
    }
    return send(res, 200, { bot: bot.name, trees });
  },
};