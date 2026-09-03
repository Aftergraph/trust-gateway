'use strict';
// v2 wave F (F1) mount: first-class Run/Step read-back + operator cancel.
//
//   GET  /v2/runs?bot=&state=&goalId=&limit=   → {runs:[Run+steps], count}
//              (bearer; default last 50, limit capped at 200)
//   GET  /v2/runs/:id                          → {run, chainRefs}
//              (bearer; run + full step list + recent chain refs for
//               provenance — every sealed entry whose payload references
//               this runId, last 20, {seq, ts, type, hash} only)
//   POST /v2/runs/:id/cancel                   → {id, state:'canceled'}
//              (operator role per canApprove(), OR the bot that owns the
//               run; → state 'canceled' + run_paused audit entry)
//
// Transparency stance (TRANSPARENCY.md): Runs/Steps carry digests only —
// argsDigest/resultDigest are sha256[:16]; no tool args, no results, no
// secrets ever appear in the store or in these responses. Chain refs are
// metadata (seq/ts/type/hash) — the payloads stay in /v1/audit where they
// already live.

const { send } = require('../server');
const { getRuns } = require('../runs');
const { canApprove } = require('../rbac');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CHAIN_REFS_KEEP = 20;
const RUN_ID_RE = /^r_[0-9a-f]{8}$/;

// RBAC for cancel: operators (canApprove semantics: role operator, cap
// approval.decide or '*') or the bot that owns the run. Everyone else 403.
function canCancel(bot, isOwner) {
  if (isOwner) return true;
  return canApprove(bot);
}

module.exports = {
  name: 'v2-runs',
  method: '*',
  path: /^\/v2\/runs(\/[^/]+)?(\/cancel)?$/,
  auth: 'bearer',
  MAX_LIMIT,
  CHAIN_REFS_KEEP,
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot; // auth:'bearer' — server already rejected otherwise
    const store = getRuns(gw);

    const m = /^\/v2\/runs(\/([^/]+))?(\/cancel)?$/.exec(ctx.url.pathname);
    const id = m && m[2] ? m[2].replace(/^\//, '') : null;
    const isCancel = Boolean(m && m[3]);

    // ── GET /v2/runs — last N runs, filterable ──
    if (!id) {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      const q = ctx.url.searchParams;
      const limit = Math.min(Math.max(Number(q.get('limit') || DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const filter = {};
      if (q.get('bot')) filter.bot = q.get('bot');
      if (q.get('state')) filter.state = q.get('state');
      if (q.get('goalId')) filter.goalId = q.get('goalId');
      const runs = store.list(filter, limit);
      return send(res, 200, { count: runs.length, runs });
    }

    if (!RUN_ID_RE.test(id)) return send(res, 400, { error: 'bad_run_id' });

    // ── POST /v2/runs/:id/cancel — operator or run owner ──
    if (isCancel) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const run = store.get(id);
      if (!run) return send(res, 404, { error: 'not_found' });
      const isOwner = bot.name === run.bot;
      if (!canCancel(bot, isOwner)) {
        // Non-privileged, non-owner attempt — record the refusal with the
        // existing forbidden vocabulary; no new audit type is warranted.
        gw._audit({ type: 'approval_forbidden', bot: bot.name, tool: `runs.cancel:${id}` });
        return send(res, 403, { error: 'operator_required' });
      }
      const canceled = store.cancel(id);
      if (!canceled) return send(res, 409, { error: `already_${run.state}` });
      return send(res, 200, { id: canceled.id, state: canceled.state, endedAt: canceled.endedAt });
    }

    // ── GET /v2/runs/:id — run + steps + provenance chain refs ──
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    const run = store.getById(id);
    if (!run) return send(res, 404, { error: 'not_found' });
    const chainRefs = gw.chain.since(0)
      .filter((e) => e.payload && e.payload.runId === id)
      .slice(-CHAIN_REFS_KEEP)
      .map((e) => ({ seq: e.seq, ts: e.ts, type: e.payload.type, hash: e.hash }));
    return send(res, 200, { run, chainRefs });
  },
};