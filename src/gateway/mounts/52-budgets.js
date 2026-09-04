'use strict';
// W3 mounts: per-bot spend caps (Slice 2).
//
//   GET  /v2/budgets            — own usage (any bot) OR all bots (operator/all-cap)
//   PUT  /v2/budgets/<bot>      — set {maxActionsPerDay}; requires canApprove(bot)
//
// 402 budget_exhausted is enforced inside server.js _postAction and
// _postApproval, NOT here. This mount is the control plane (limits);
// the server owns the enforcement plane.
//
// RBAC: PUT requires the operator gate (canApprove from server.js).
// Non-approvers get 403 + an audit entry type:'budget_forbidden'.
// Body must contain maxActionsPerDay as a positive integer ≤ 100000.

const { send, readBody, canApprove } = require('../server');

const PATH_RE = /^\/v2\/budgets(?:\/([a-z][a-z0-9-]{1,31}))?$/;

function isAllCap(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('approval.decide') || caps.includes('*');
}

function getBudgets(gw, req, res, ctx) {
  const store = gw.budgets;
  if (!store) {
    // feature off — report empty set so callers can detect capability
    return send(res, 200, { budgets: {}, unlimited: true });
  }
  if (isAllCap(ctx.bot)) {
    const out = {};
    for (const name of Object.keys(store.bots)) {
      const u = store.getUsage(name);
      if (u) out[name] = u;
    }
    return send(res, 200, { budgets: out });
  }
  const own = store.getUsage(ctx.bot.name);
  return send(res, 200, { budgets: { [ctx.bot.name]: own } });
}

async function putBudget(gw, req, res, ctx, botName) {
  if (!canApprove(ctx.bot)) {
    gw._audit({ type: 'budget_forbidden', bot: botName, by: ctx.bot.name });
    return send(res, 403, { error: 'operator_required' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch {
    return send(res, 400, { error: 'invalid_json' });
  }
  const { maxActionsPerDay } = body || {};
  if (!Number.isInteger(maxActionsPerDay) || maxActionsPerDay <= 0 || maxActionsPerDay > 100000) {
    return send(res, 400, { error: 'invalid_limit', max: 100000 });
  }
  if (!gw.budgets) return send(res, 503, { error: 'budgets_disabled' });
  try {
    const limit = gw.budgets.setLimit(botName, { maxActionsPerDay });
    gw._audit({ type: 'budget_set', bot: botName, by: ctx.bot.name, maxActionsPerDay });
    return send(res, 200, { ok: true, bot: botName, ...limit });
  } catch (e) {
    return send(res, 400, { error: 'invalid_limit', message: String(e && e.message) });
  }
}

module.exports = {
  name: 'v2-budgets',
  method: '*',
  path: PATH_RE,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const m = ctx.url.pathname.match(PATH_RE);
    if (!m) return send(res, 404, { error: 'not_found' });
    const botName = m[1];
    if (!botName && req.method === 'GET') return getBudgets(gw, req, res, ctx);
    if (botName && req.method === 'PUT') return putBudget(gw, req, res, ctx, botName);
    return send(res, 405, { error: 'method_not_allowed' });
  },
};