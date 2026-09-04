'use strict';
// v2 mount: GET /v2/rate-limit — current rate-limit configuration +
// per-token remaining budget for the authenticated caller.
//
// STRICT: never returns token values. Only the caller's own remaining
// budget is exposed (so a token can't probe other tokens' remaining).
//
// Auth: bearer (any role). Operator multiplier is reported as the raw
// configured multiplier (the bot's own effective budget = base * mult).
//
// Response shape:
//   { config: { base, operatorMultiplier, windowMs },
//     you: { role, budget, remaining, windowStart } }
//
// If the caller hasn't been counted this window, you.remaining is null
// (no consumption to report yet).

const { send } = require('../server');

module.exports = {
  name: 'v2-rate-limit',
  method: 'GET',
  path: '/v2/rate-limit',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const me = ctx.bot || {};
    const snapshot = gw._rateSnapshot(me.name);
    const role = typeof me.role === 'string' ? me.role : null;
    const mult = role === 'operator' ? gw.rateOperatorMult : 1;
    send(res, 200, {
      config: {
        base: gw.rateLimit,
        operatorMultiplier: gw.rateOperatorMult,
        windowMs: 60 * 1000,
      },
      you: {
        role,
        budget: gw.rateLimit * mult,
        remaining: snapshot ? snapshot.remaining : null,
        windowStart: snapshot ? snapshot.windowStart : null,
      },
    });
  },
};