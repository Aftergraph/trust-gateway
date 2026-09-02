'use strict';
// v2 mount: GET /v2/bots — directory of configured bots.
//
// STRICT: no tokens, ever. The projection is a hand-picked allow-list of
// fields (name, role, capabilities) so a future code change that adds a
// sensitive field to gw.bots cannot accidentally leak it through this
// endpoint.
//
// Auth: bearer (operator-equivalent).

const { send } = require('../server');

module.exports = {
  name: 'v2-bots',
  method: 'GET',
  path: '/v2/bots',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    const out = [];
    for (const [name, b] of Object.entries(gw.bots)) {
      out.push({
        name,
        role: b && typeof b.role === 'string' ? b.role : null,
        capabilities: Array.isArray(b && b.capabilities) ? b.capabilities.slice() : [],
      });
    }
    send(res, 200, { bots: out });
  },
};
