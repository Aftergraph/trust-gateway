'use strict';
// FS-J2 mount — secrets master-key rotation over HTTP. OPERATOR-ONLY (same
// isOperator gate as 115-secrets / 113-tenants / 110-backup).
//
//   POST /v2/secrets/rotate-master  body {newMasterKey}
//     → 200 {ok:true, rotatedCount}
//     → 404 {error:'vault_disabled'}   TG_SECRETS_VAULT off (feature = not there)
//     → 400 {error:'same_key'}         newMasterKey === current master
//     → 400 {error:'weak_key'}         newMasterKey missing / < 16 chars
//     → 409 {error:'rotate_failed', failedCount, failedKeys}
//                                      any row failed to decrypt under the
//                                      current master → whole rotation
//                                      ABORTED (tx rollback, zero writes);
//                                      heal the listed rows and retry.
//
// THE NEW MASTER KEY IS NEVER LOGGED, AUDITED, OR ECHOED — not even a length.
// Audit payloads carry counts and (tenant, key, error) triples for FAILED
// rows only; failed rows keep their old ciphertext so nothing is lost.
//
// Auditing (docs/standards/TRANSPARENCY.md rows 140-141):
//   secret_master_rotated       — accepted rotation: {rotatedCount} only
//   secret_master_rotate_failed — aborted rotation or RBAC refusal:
//                                 {failedCount, errors[]} / {bot}

const { send, readBody } = require('../server');
const { getSecretsVault } = require('../secrets-vault');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-secrets-rotate-master',
  method: 'POST',
  path: /^\/v2\/secrets\/rotate-master$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'secret_master_rotate_failed', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const vault = getSecretsVault(gw);
    if (!vault.enabled) {
      return send(res, 404, { error: 'vault_disabled' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }
    const { newMasterKey } = body;
    if (typeof newMasterKey !== 'string' || newMasterKey.length < 16) {
      return send(res, 400, { error: 'weak_key' });
    }
    if (newMasterKey === vault.master) {
      return send(res, 400, { error: 'same_key' });
    }

    let result;
    try {
      result = vault.rotateMasterKey(newMasterKey);
    } catch (e) {
      const msg = e && e.message ? e.message : '';
      if (msg.includes('too short')) return send(res, 400, { error: 'weak_key' });
      if (msg.includes('equals current')) return send(res, 400, { error: 'same_key' });
      if (msg.includes('vault_disabled')) return send(res, 404, { error: 'vault_disabled' });
      return send(res, 500, { error: 'vault_error' });
    }

    if (!result.ok) {
      gw._audit({
        type: 'secret_master_rotate_failed',
        by: ctx.bot.name,
        failedCount: result.failedKeys.length,
        errors: result.failedKeys, // {tenant, key, error} — names, never values
      });
      return send(res, 409, {
        error: 'rotate_failed',
        failedCount: result.failedKeys.length,
        failedKeys: result.failedKeys,
      });
    }

    gw._audit({
      type: 'secret_master_rotated',
      by: ctx.bot.name,
      rotatedCount: result.rotatedCount,
    });
    return send(res, 200, { ok: true, rotatedCount: result.rotatedCount });
  },
};
