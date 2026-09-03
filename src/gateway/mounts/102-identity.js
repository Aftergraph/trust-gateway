'use strict';
// FS-A2 mount: GET /v2/me — identity projection for the logged-in user.
//
// Identity resolution order:
//   1. gw._currentUser(req)  — FS-A1 session identity (pluggable hook; absent
//      until FS-A1 lands, in which case this step is skipped entirely).
//   2. bearer token          — the gateway bot identity, projected exactly
//      like GET /v2/whoami does today (behavior preserved).
//   3. neither               → 401 unauthorized (auth_rejected audited,
//      mirroring the mount runner's bearer rejection).
//
// User projection is STRICT: user fields minus any password/secret material,
// plus botGrants verbatim plus the capabilities those grants imply (see
// src/gateway/user-access.js). No hash, token or credential is ever returned.
//
// FS-E1 slice 3: the body gains ONE added field — `tenant: resolved.id`
// (resolveTenant). Byte-identical for the default 'main' tenant apart from
// that field. When the resolver answers {tenant: null} (unknown/disabled
// tenant on an explicit claim) the field is OMITTED — identity surfaces
// never lock out, and nothing is revealed either way (anti-enumeration:
// no 403, no tenant-specific error body).
//
// Audit: 'identity_me' carries {userId} ONLY — no email, no name, no token.

const { send } = require('../server');
const { projectUser } = require('../user-access');
const { resolveTenant } = require('../tenant-resolve');

module.exports = {
  name: 'v2-identity',
  method: 'GET',
  path: '/v2/me',
  // In-handler identity (not 'bearer'): a session user may authenticate
  // without a bearer token, so the runner must not 401 before we look.
  auth: 'none',
  handle: async (gw, req, res) => {
    // FS-E1 slice 3 — resolved tenant id (added field; omitted when null).
    // The bot is attached to the request BEFORE resolving so the resolver
    // can honour the operator-only X-Tenant header (same wiring as
    // 02-tenant-healthz; a non-operator header is ignored, never leaked).
    const bot = gw._auth(req);
    req.bot = bot;
    const { tenant } = resolveTenant(req, gw);
    const tenantField = tenant ? { tenant: tenant.id } : {};
    const user = typeof gw._currentUser === 'function' ? gw._currentUser(req) : null;
    if (user) {
      gw._audit({ type: 'identity_me', userId: user.id });
      return send(res, 200, Object.assign(projectUser(user, gw), tenantField));
    }
    // Bearer fallback: bot identity, byte-for-byte the /v2/whoami projection
    // (behavior preserved) plus the added tenant field.
    if (bot) {
      return send(res, 200, Object.assign({
        name: bot.name,
        role: typeof bot.role === 'string' ? bot.role : 'worker',
        capabilities: Array.isArray(bot.capabilities) ? bot.capabilities.slice() : [],
      }, tenantField));
    }
    gw._audit({ type: 'auth_rejected', path: '/v2/me' });
    return send(res, 401, { error: 'unauthorized' });
  },
};
