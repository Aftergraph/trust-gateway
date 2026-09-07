'use strict';

// Platform Convergence V2.1: read-only canonical identity projection.
// Authentication/session state resolves identity only. This endpoint never
// issues AuthorityLeases, capabilities, approvals, execution tokens, or
// WorkerLeases.

const { send } = require('../server');
const { resolvePlatformIdentity } = require('../platform-identity');

module.exports = {
  name: 'v2-platform-identity',
  method: 'GET',
  path: '/v2/platform/identity',
  // Session users may authenticate without bearer credentials, so resolution
  // happens inside the handler just like /v2/me.
  auth: 'none',
  handle: async (gw, req, res) => {
    const result = resolvePlatformIdentity(req, gw);
    if (result.status === 401) {
      // Reuse the existing audit vocabulary. Do not create identity-specific
      // audit events that would broaden the transparency contract here.
      gw._audit({ type: 'auth_rejected', path: '/v2/platform/identity' });
    }
    return send(res, result.status, result.body);
  },
};
