'use strict';
// FS-I4 mount — operator-gated audit-export self-test.
//
//   POST /v2/audit/export/test → {webhookOk, s3StubOk, lastError}
//
// SECURITY: operator-only (role 'operator' or '*' cap), same gate as
// 110-backup / 112-apikeys / 113-tenants / 114-observability. Workers get
// 403 {error:'operator_required'} + `audit_export_denied`. The call is
// itself audited (`audit_export_test` {by, webhookOk, s3StubOk}) — never
// token material, never entry contents. The synthetic probe entry is
// labeled synthetic and is NOT sealed into the chain (it is delivery
// probe data, not a governance fact).
//
// With both TG_AUDIT_EXPORT_WEBHOOK and TG_AUDIT_EXPORT_S3_BUCKET unset the
// sink is inert: the endpoint still answers (all false + inert flag) so an
// operator can verify the OFF state — zero side effects.

const { send, readBody } = require('../server');
const { getExportSink } = require('../audit-export');
const { wireExportSink } = require('../events');

// wave-C convention: server.js registers mount executors at Gateway
// construction — this is how the export tap gets attached eagerly (an SSE
// client never has to connect first) without touching server.js. The
// executor RegExp never matches a real tool name; wireExportSink() is
// idempotent (also called from EventHub) and inert when env is unset.
module.exports.executors = [{
  re: /^audit-export:wiring$/,
  make: (gw) => {
    wireExportSink(gw);
    return async () => ({ ok: true });
  },
}];

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'audit-export-test',
  method: 'POST',
  path: '/v2/audit/export/test',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'audit_export_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    await readBody(req).catch(() => ''); // tolerate/ignore any body
    const sink = getExportSink(gw);
    const result = await sink.testDelivery();
    gw._audit({
      type: 'audit_export_test',
      by: ctx.bot.name,
      webhookOk: !!result.webhookOk,
      s3StubOk: !!result.s3StubOk,
    });
    return send(res, 200, {
      webhookOk: !!result.webhookOk,
      s3StubOk: !!result.s3StubOk,
      lastError: result.lastError || null,
    });
  },
};
