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
// Audit: 'identity_me' carries {userId} ONLY — no email, no name, no token.

const { send } = require('../server');
const { projectUser } = require('../user-access');

module.exports = {
  name: 'v2-identity',
  method: 'GET',
  path: '/v2/me',
  // In-handler identity (not 'bearer'): a session user may authenticate
  // without a bearer token, so the runner must not 401 before we look.
  auth: 'none',
  handle: async (gw, req, res) => {
    const user = typeof gw._currentUser === 'function' ? gw._currentUser(req) : null;
    if (user) {
      gw._audit({ type: 'identity_me', userId: user.id });
      return send(res, 200, projectUser(user, gw));
    }
    // Bearer fallback: bot identity, byte-for-byte the /v2/whoami projection.
    const bot = gw._auth(req);
    if (bot) {
      return send(res, 200, {
        name: bot.name,
        role: typeof bot.role === 'string' ? bot.role : 'worker',
        capabilities: Array.isArray(bot.capabilities) ? bot.capabilities.slice() : [],
      });
    }
    gw._audit({ type: 'auth_rejected', path: '/v2/me' });
    return send(res, 401, { error: 'unauthorized' });
  },
};
