'use strict';
// FS-G2 mount — GET /v2/observability. OPERATOR-ONLY (same isOperator gate
// as 110-backup/112-apikeys/113-tenants).
//
// Returns the scalar projection from ../obsv.js snapshot(gw): chain
// verify scalars, telemetry top-5 type counts (no raw payloads), pending
// approvals, apikey rate-limit counters, tenant counts, skill visibility
// counts, backup-manifest scalars, events-hub client count, uptime. No
// caching — computed per call; the ring memory used is bounded (top-5
// counts only; backup section reads at most 10 manifests). Audited:
// observability_read {by} — the operator name only, never token material.
//
// Workers get 403 {error:'operator_required'} + observability_denied.

const { send } = require('../server');
const { snapshot } = require('../obsv');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-observability',
  method: 'GET',
  path: '/v2/observability',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'observability_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    gw._audit({ type: 'observability_read', by: ctx.bot.name });
    return send(res, 200, snapshot(gw));
  },
};
