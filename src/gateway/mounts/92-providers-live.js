'use strict';
// D5 mount — live provider observability surface.
//
//   GET /v2/providers/live → probeAll(gw) results
//
// Auth: bearer. RBAC: gate on bot.role === 'operator' (403 for workers).
// Mirrors the approvals surface gate pattern.

const { send } = require('../server');
const { canApprove } = require('../rbac');
const { probeAll } = require('../providers-live');

module.exports = {
  name: 'v2-providers-live',
  method: 'GET',
  path: '/v2/providers/live',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    if (!canApprove(bot)) {
      gw._audit({ type: 'provider_live_access_denied', bot: bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const results = await probeAll(gw);
    // Audit the access (not the results, to avoid leaking latency patterns that could fingerprint env)
    gw._audit({ type: 'provider_live_probed', bot: bot.name, count: results.length });
    return send(res, 200, { providers: results });
  },
};
