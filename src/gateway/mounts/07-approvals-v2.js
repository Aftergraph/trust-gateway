'use strict';
// Approvals-v2: batch resolution + queue metrics (P1 wave).
//   POST /v2/approvals/batch    {ops: [{id, verdict: approve|deny}], approver}
//     — resolves each through the SAME store.resolve() as the v1 single path
//       (RBAC + audit + dispatch semantics inherited per op); stops accumulating
//       results, never aborts the batch on individual errors (per-op status).
//   GET  /v2/approvals/metrics  queue depth, oldest pending age, verdict counts
//
// RBAC: batch + metrics are operator-only (they mutate/read across all tenants'
// pending queues in the main store).

const { send, readBody } = require('../server');
const { canApprove } = require('../rbac');

const RE = /^\/v2\/approvals\/(batch|metrics)\/?$/;

async function readJson(req) {
  try {
    const raw = await readBody(req);
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: 'invalid_json' };
  }
}

module.exports = {
  name: 'v2-approvals-v2',
  method: '*',
  path: /^\/v2\/approvals\/(batch|metrics)(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const action = m[1];

    if (!gw.approvals) return send(res, 503, { error: 'approvals_unavailable' });

    if (req.method === 'GET' && action === 'metrics') {
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'approvals_metrics_forbidden', bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      const pending = gw.approvals.listPending();
      const now = Date.now();
      const ages = pending
        .map((r) => now - (r.createdAt || now))
        .sort((a, b) => b - a);
      const byTool = {};
      for (const r of pending) byTool[r.tool || 'unknown'] = (byTool[r.tool || 'unknown'] || 0) + 1;
      return send(res, 200, {
        queue_depth: pending.length,
        oldest_pending_ms: ages[0] || 0,
        oldest_pending_hours: Math.round((ages[0] || 0) / 360000) / 10,
        by_tool: byTool,
        ttl_ms: gw.approvals.ttlMs,
      });
    }

    if (req.method === 'POST' && action === 'batch') {
      if (!canApprove(ctx.bot)) {
        gw._audit({ type: 'approvals_batch_forbidden', bot: ctx.bot.name });
        return send(res, 403, { error: 'operator_required' });
      }
      const { body, error } = await readJson(req);
      if (error) return send(res, 400, { error });
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (ops.length === 0) return send(res, 400, { error: 'ops_required' });
      if (ops.length > 100) return send(res, 400, { error: 'batch_too_large' });

      const results = [];
      let approved = 0, denied = 0, failed = 0;
      for (const op of ops) {
        try {
          if (!op || typeof op.id !== 'string' || !['approve', 'deny'].includes(op.verdict)) {
            throw new Error('invalid_op');
          }
          const row = gw.approvals.resolve(op.id, op.verdict, ctx.bot.name);
          if (!row || row.ok === false) throw new Error((row && row.error) || 'resolve_failed');
          results.push({ id: op.id, verdict: op.verdict, ok: true, status: row.status });
          if (op.verdict === 'approve') approved++;
        } catch (e) {
          results.push({ id: op && op.id || null, verdict: op && op.verdict || null, ok: false, error: String(e.message) });
        }
      }
      gw._audit({ type: 'approvals_batch_resolved', approver: ctx.bot.name, ops: ops.length, approved: approved });
      return send(res, 200, { ok: true, results });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};