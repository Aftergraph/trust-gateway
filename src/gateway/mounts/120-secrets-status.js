'use strict';
// v2q-(b) — vault-status aggregate: GET /v2/secrets → operator-oversigt over
// vault-et: enabled, masterRotatedAt (max updated_at), tenants med key-navne.
//
//   GET /v2/secrets → 200 {enabled, masterRotatedAt, tenants: [{tenant, keys}]}
//                    404 {error:'vault_disabled'}   når TG_SECRETS_VAULT=0
//
// SECRET VALUES NEVER LEAVE THE VAULT: keys only (like 115-secrets GET).
// Master key is never exposed — not even a length — and rotation timestamp
// comes from vault-row updated_at maxima, not from any key material.
// Audited: secret_vault_status {bot} (operator surface only).
//
// Operator-only, same isOperator gate as 115-secrets / 119-secrets-rotate.

const { send } = require('../server');
const { getSecretsVault, TABLE } = require('../secrets-vault');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-secrets-status',
  method: 'GET',
  path: /^\/v2\/secrets$/,
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

    // Distinct tenants fra vault-tabellen — aldrig values.
    const tenants = vault.db
      .prepare(`SELECT DISTINCT tenant FROM ${TABLE} ORDER BY tenant`)
      .all()
      .map((r) => r.tenant);

    const masterRotatedAt = vault.db
      .prepare(`SELECT MAX(updated_at) AS at FROM ${TABLE}`)
      .get();

    gw._audit({ type: 'secret_vault_status', bot: ctx.bot && ctx.bot.name, tenants: tenants.length });
    return send(res, 200, {
      enabled: true,
      masterRotatedAt: masterRotatedAt && masterRotatedAt.at
        ? new Date(masterRotatedAt.at).toISOString()
        : null,
      tenants: tenants.map((t) => ({ tenant: t, keys: vault.listKeys(t) })),
    });
  },
};