'use strict';
// FS-E1 slice 3 — tenant CRUD surface. OPERATOR-ONLY (same isOperator gate
// as 110-backup/112-apikeys). Tenant rows carry no secret material by
// design, but the list projection is still explicit (id/name/created_at/
// disabled only — whatever the store returns, nothing added).
//
//   GET  /v2/tenants              → {tenants:[...]} (no secrets)
//   POST /v2/tenants              → create {name} → 201 {ok, id, record}
//   POST /v2/tenants/:id/disable  → 200 {ok, record}
//   POST /v2/tenants/:id/enable   → 200 {ok, record}
//
// Audited: tenant_created {id, name}, tenant_disabled {id},
// tenant_enabled {id}, tenant_denied {bot} — RBAC refusal audited like
// apikey_denied/backup_denied.

const { send, readBody } = require('../server');
const { getTenantStore } = require('../tenants');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-tenants',
  method: '*',
  path: /^\/v2\/tenants(?:\/([^/]+)\/(disable|enable))?$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'tenant_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const store = getTenantStore(gw);
    const m = ctx.params.matches || [];
    const id = m[1] || null;
    const action = m[2] || null;

    // ── GET /v2/tenants — list (id/name/created_at/disabled, no secrets) ──
    if (req.method === 'GET' && !id) {
      return send(res, 200, { tenants: store.list() });
    }

    // ── POST /v2/tenants — create {name} ──
    if (req.method === 'POST' && !id) {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      const out = store.create({ name: body.name });
      if (!out.ok) return send(res, 400, { error: out.error });
      gw._audit({ type: 'tenant_created', id: out.id, name: out.record.name });
      return send(res, 201, { ok: true, id: out.id, record: out.record });
    }

    // ── POST /v2/tenants/:id/disable | /:id/enable ──
    if (req.method === 'POST' && id && action) {
      const out = store.setDisabled(id, action === 'disable');
      if (!out.ok) return send(res, 404, { error: 'not_found' });
      // literal type strings (docs↔code sync gate extracts these verbatim)
      if (action === 'disable') gw._audit({ type: 'tenant_disabled', id: out.record.id });
      else gw._audit({ type: 'tenant_enabled', id: out.record.id });
      return send(res, 200, { ok: true, record: out.record });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
