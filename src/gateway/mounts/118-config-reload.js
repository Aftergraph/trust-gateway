'use strict';
// FS-I6 mount — operator config hot-reload over HTTP.
//
//   POST /v2/config/reload   → operator-only. Triggers the exact same reload
//                              a SIGHUP runs (src/gateway/hot-reload.js),
//                              synchronously awaited, then answers with the
//                              result: {changed:[...], errors:[...]}.
//
// Auditing (docs/standards/TRANSPARENCY.md rows 131-132):
//   - config_reloaded        — every accepted reload, changed key NAMES +
//                              error COUNT only (never values — the error
//                              list can carry an invalid numeric literal
//                              and key names can hint at topology).
//   - config_reload_failed   — when the reload reported errors. Old values
//                              stay in effect for any failed key; the
//                              gateway never crashes on a bad reload.
//
// 403 operator_required for workers, audited as config_reload_failed with
// the bot name — same pattern as 110-backup / 114-observability.

const { send } = require('../server');
const { reload } = require('../hot-reload');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

// Audit types (TRANSPARENCY.md rows 131-132): emitted as literal
// `type: '…'` strings in the branches below — the docs↔code extraction rule
// (tests/standards.test.js) matches quoted literals directly after `type:`.
const TYPE_RELOADED = 'config_reloaded';
const TYPE_FAILED = 'config_reload_failed';

module.exports = {
  name: 'config-reload',
  method: 'POST',
  path: /^\/v2\/config\/reload$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: TYPE_FAILED, bot: ctx.bot && ctx.bot.name, error: 'operator_required' });
      return send(res, 403, { error: 'operator_required' });
    }
    const result = await reload(gw); // never throws — hot-reload.js contract
    const failed = Array.isArray(result.errors) && result.errors.length > 0;
    if (failed) {
      gw._audit({
        type: 'config_reload_failed',
        by: ctx.bot.name,
        changed: result.changed,
        errorCount: result.errors.length, // count only — never values
      });
    } else {
      gw._audit({ type: 'config_reloaded', by: ctx.bot.name, changed: result.changed });
    }
    return send(res, 200, { changed: result.changed, errors: result.errors });
  },
};
