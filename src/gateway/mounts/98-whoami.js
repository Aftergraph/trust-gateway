'use strict';
// v2 mount: GET /v2/whoami — the calling identity (name, role, capabilities).
//
// Phase 3 (§5.1): the composition engine needs `permissions` for the CURRENT
// identity; the console token maps to exactly one bot, and this is the only
// honest way to learn it client-side. STRICT projection like /v2/bots:
// name/role/capabilities only — no tokens, no hashes, ever.
//
// Closes UX-spec BACKEND GAP "TG.session / identity resolution" in its
// minimal form (capability-grants read; scopes/roles beyond worker|operator
// remain future work).

const { send } = require('../server');

module.exports = {
  name: 'v2-whoami',
  method: 'GET',
  path: '/v2/whoami',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const bot = ctx.bot;
    send(res, 200, {
      name: bot.name,
      role: typeof bot.role === 'string' ? bot.role : 'worker',
      capabilities: Array.isArray(bot.capabilities) ? bot.capabilities.slice() : [],
    });
  },
};
