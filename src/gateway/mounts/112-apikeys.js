'use strict';
// FS-E3 mount — external API key CRUD. OPERATOR-ONLY (same isOperator gate
// as 110-backup). The plaintext is returned exactly once, at create; every
// other surface projects the key_hint only. Audited: apikey_created /
// apikey_revoked — id + name, NEVER the plaintext.
//
//   GET  /v2/apikeys            → list (key_hint, no hash, no plaintext)
//   POST /v2/apikeys            → create {name, scopes, rate?} → 201 {id, plaintext, record}
//   POST /v2/apikeys/:id/revoke → 200 {ok}

const { send, readBody } = require('../server');
const { getApiKeyStore } = require('../apikeys');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-apikeys',
  method: '*',
  path: /^\/v2\/apikeys(?:\/([^/]+)\/revoke)?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'apikey_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const store = getApiKeyStore(gw);
    const revokeId = ctx.params.matches ? ctx.params.matches[1] : null;

    if (req.method === 'GET' && !revokeId) {
      return send(res, 200, { keys: store.list() });
    }

    if (req.method === 'POST' && !revokeId) {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      const out = store.create({ name: body.name, owner: ctx.bot.name, scopes: body.scopes, rate: body.rate });
      if (!out.ok) return send(res, 400, { error: out.error });
      gw._audit({ type: 'apikey_created', id: out.id, name: out.record.name, scopes: out.record.scopes });
      return send(res, 201, { id: out.id, plaintext: out.plaintext, record: out.record });
    }

    if (req.method === 'POST' && revokeId) {
      const out = store.revoke(revokeId);
      if (!out.ok) return send(res, 404, { error: 'not_found' });
      gw._audit({ type: 'apikey_revoked', id: revokeId, by: ctx.bot.name });
      return send(res, 200, { ok: true, record: out.record });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};