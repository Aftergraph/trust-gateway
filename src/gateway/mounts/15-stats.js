'use strict';
// v2 mount: GET /v2/stats — operational summary of the gateway.
//
// Returns a small JSON snapshot: chain length, head hash + ts, whether
// the chain currently verifies, how many approvals are pending, and a
// per-bot action count derived by scanning the chain.
//
// Auth: bearer (operator-equivalent). The mount runner has already
// validated the token against gw.bots before this handler runs.

const { send } = require('../server');

module.exports = {
  name: 'v2-stats',
  method: 'GET',
  path: '/v2/stats',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const chain = gw.chain;
    const verification = chain.verify();
    const head = chain.head;
    const pendingCount = gw.approvals.listPending().length;

    // Walk the chain once and bucket action events by bot. We treat any
    // audit entry whose payload carries a `bot` field as belonging to
    // that bot; the dashboard only cares about per-bot activity, not
    // pre-seal vs. post-approval classification.
    const bots = {};
    for (const [name, b] of Object.entries(gw.bots)) {
      bots[name] = { actions: 0, approvals: 0, denies: 0 };
    }
    for (const entry of chain.entries) {
      const p = entry.payload || {};
      if (p.type === 'genesis') continue;
      const owner = p.bot || null;
      if (!owner || !bots[owner]) continue;
      // Tally outcomes. We only count dispatched / decided events, not
      // every audit row, so the numbers map to what an operator did.
      if (p.type === 'action_decision') bots[owner].actions += 1;
      else if (p.type === 'action_executed' || p.type === 'action_executed_after_approval') bots[owner].actions += 1;
      else if (p.type === 'approval_requested') bots[owner].approvals += 1;
      else if (p.type === 'auth_rejected' || p.type === 'approval_forbidden') bots[owner].denies += 1;
    }

    send(res, 200, {
      entries: chain.entries.length,
      head: head ? head.hash : null,
      chainId: chain.chainId,
      verified: verification.ok,
      lastTs: head ? head.ts : null,
      pendingCount,
      bots,
    });
  },
};
