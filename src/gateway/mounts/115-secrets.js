'use strict';
// FS-I5 — tenant-scoped secrets vault operator surface. OPERATOR-ONLY
// (same isOperator gate as 113-tenants / 110-backup / 112-apikeys).
//
//   PUT    /v2/tenants/:id/secrets/:key  body {value}  → 200 {ok, key, tenant}
//   GET    /v2/tenants/:id/secrets                     → 200 {keys: [...]}
//   DELETE /v2/tenants/:id/secrets/:key                → 200 {ok, deleted}
//
// SECRET VALUES ARE NEVER EXPOSED: the GET route is a KEY-ONLY list (the
// store method listKeys already guarantees values never leave the vault);
// there is no GET-for-value route at all — only internal code paths consume
// getSecret(). PUT/DELETE list routes are inert unless TG_SECRETS_VAULT=1
// (404 vault_disabled, matching the skills-federation env-gate discipline of
// answering 404 when the feature is off) — and the TABLE never holds
// plaintext. Audited: secret_set {tenant, key}, secret_deleted {tenant, key},
// secret_listed {tenant}, secret_denied {bot} — key NAMES only, never values.

const { send, readBody } = require('../server');
const { getSecretsVault } = require('../secrets-vault');
const { isValidTenantId } = require('../tenants');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-tenant-secrets',
  method: '*',
  path: /^\/v2\/tenants\/([^/]+)\/secrets(?:\/([^/]+))?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'secret_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const vault = getSecretsVault(gw);
    if (!vault.enabled) {
      return send(res, 404, { error: 'vault_disabled' });
    }
    const [_, tenant, key] = ctx.params.matches || [];

    // ── PUT /v2/tenants/:id/secrets/:key — set (value from body, never logged) ──
    if (req.method === 'PUT' && tenant && key) {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      if (typeof body.value !== 'string') {
        return send(res, 400, { error: 'value_required' });
      }
      try {
        vault.setSecret(tenant, key, body.value);
      } catch (e) {
        return send(res, 400, { error: e && e.message === 'vault: invalid tenant id (fail closed)'
          ? 'invalid_tenant' : 'vault_error' });
      }
      gw._audit({ type: 'secret_set', tenant, key });
      return send(res, 200, { ok: true, tenant, key });
    }

    // ── GET /v2/tenants/:id/secrets — KEY LIST ONLY (never values) ──
    if (req.method === 'GET' && tenant && !key) {
      if (!isValidTenantId(tenant)) return send(res, 404, { error: 'not_found' });
      const keys = vault.listKeys(tenant);
      gw._audit({ type: 'secret_listed', tenant });
      return send(res, 200, { keys });
    }

    // ── DELETE /v2/tenants/:id/secrets/:key ──
    if (req.method === 'DELETE' && tenant && key) {
      const ok = vault.deleteSecret(tenant, key);
      gw._audit({ type: 'secret_deleted', tenant, key });
      return send(res, ok ? 200 : 404, { ok, tenant, key });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
