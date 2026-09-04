'use strict';
// P1 mount: /v2/context/:bot — Context Inspector v1.
//   GET /v2/context/:bot   aggregated context snapshot (self-inspection allowed;
//                          other bots' context requires operator role)
const { send } = require('../server');
const { canApprove } = require('../rbac');
const { buildContextSnapshot } = require('../context-inspector');

const RE = /^\/v2\/context\/([^/]+)\/?$/;

module.exports = {
  name: 'v2-context',
  method: 'GET',
  path: /^\/v2\/context(\/|$)/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = RE.exec(ctx.url.pathname);
    if (!m) return send(res, 404, { error: 'not_found' });
    const botName = m[1];

    // Privacy: an agent may always inspect ITS OWN context; another bot's context
    // requires operator rights (the snapshot reveals budgets/memory/approvals).
    const isSelf = ctx.bot.name === botName;
    if (!isSelf && !canApprove(ctx.bot)) {
      gw._audit({ type: 'context_forbidden', bot: ctx.bot.name, target: botName });
      return send(res, 403, { error: 'operator_required' });
    }

    const snapshot = buildContextSnapshot({
      botName,
      agentStore: gw._agentStore || (gw.agents && gw.agents.store) || null,
      budgets: gw.budgets || null,
      memoryStore: gw._memoryStore || null,
      projectStore: gw._projectStore || null,
      approvals: gw.approvals || null,
      worksConfigured: !!process.env.WORKS_API_URL,
    });

    gw._audit({ type: 'context_inspected', bot: ctx.bot.name, target: botName, snapshot_hash: snapshot.snapshot_hash });
    return send(res, 200, snapshot);
  },
};