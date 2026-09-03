'use strict';
// FS-E1 slice 1 — MINIMAL tenant wiring. server.js and bin/gateway.js stay
// untouched: mounts run before built-in routes, so this shadows the v1
// /healthz and returns a SUPERSET of the old body ({ok, chain} + tenant),
// proving the resolver runs without rewiring any other mount (slices 2-3
// own that). Unknown/disabled tenant on any route → 404, never 403
// (anti-enumeration).

const { send } = require('../server');
const { resolveTenant } = require('../tenant-resolve');

module.exports = {
  name: 'tenant-healthz',
  method: 'GET',
  path: '/healthz',
  auth: 'none', // healthz stays unauthenticated (body is non-secret)
  handle: async (gw, req, res, ctx) => {
    // auth:'none' mounts get ctx.bot=null — resolve operator-ness ourselves
    // from the bearer header (read-only check, never an auth decision).
    req.bot = ctx.bot || gw._auth ? (ctx.bot || (gw._auth ? gw._auth(req) : null)) : null;
    const { tenant } = resolveTenant(req, gw);
    if (!tenant) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { ok: true, chain: gw.chain.verify(), tenant: tenant.id });
  },
};
