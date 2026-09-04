'use strict';
// P2 mount: /v2/evals — golden-set eval gate.
//   POST /v2/evals/run      run all golden sets (operator-only; side effects: writes
//                           tmp dirs + eval ledger)
//   GET  /v2/evals/latest   latest run summary (operator: gate decision surface)
const { send } = require('../server');
const { canApprove } = require('../rbac');
const { EvalRunner } = require('../evals');
const path = require('node:path');

module.exports = {
  name: 'v2-evals',
  method: '*',
  path: /^\/v2\/evals(\/latest)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!canApprove(ctx.bot)) {
      gw._audit({ type: 'evals_forbidden', bot: ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    if (!gw._evalRunner) {
      gw._evalRunner = new EvalRunner({
        file: process.env.TG_EVAL_LEDGER || path.join(process.cwd(), 'data', 'eval-ledger.json'),
      });
    }
    const runner = gw._evalRunner;
    if (req.method === 'POST' && ctx.url.pathname === '/v2/evals/run') {
      const run = runner.runAll();
      gw._audit({ type: 'evals_run', gate: run.gate, total: run.total, failed: run.failed, snapshot_hash: run.snapshot_hash });
      return send(res, 200, { ok: true, run });
    }
    if (req.method === 'GET' && ctx.url.pathname === '/v2/evals/latest') {
      const run = runner.latest();
      if (!run) return send(res, 404, { error: 'no_runs_yet' });
      return send(res, 200, run);
    }
    return send(res, 405, { error: 'method_not_allowed' });
  },
};