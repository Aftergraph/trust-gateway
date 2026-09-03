'use strict';
// FS-I3 mount — per-tenant quota management. OPERATOR-ONLY (same isOperator
// gate as 110-backup/112-apikeys/113-tenants).
//
//   PUT /v2/tenants/:id/quota   {maxDiskMb?, maxApiPerHour?}  → setQuota
//   GET /v2/tenants/:id/quota   → current usage + limits
//
// Both audited: tenant_quota_set {id, by} on PUT, tenant_quota_read {id, by}
// on GET. Worker/anonymous access → 403/401 with tenant_quota_denied,
// mirroring tenant_denied in 113-tenants. Unknown tenant id (or a non-slug)
// → 404 {error:'not_found'} (anti-enumeration, same as 113).
//
// Note: this mount does NOT go through the quota middleware — operators
// managing quotas must never be locked out by the very limits they set.

const { send, readBody } = require('../server');
const { getTenantStore, isValidTenantId } = require('../tenants');
const { getTenantQuotas } = require('../tenant-quotas');

function isOperator(bot) {
  if (!bot) return false;
  if (bot.role === 'operator') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('*');
}

module.exports = {
  name: 'v2-tenant-quotas',
  method: '*',
  path: /^\/v2\/tenants\/([^/]+)\/quota$/,
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    if (!isOperator(ctx.bot)) {
      gw._audit({ type: 'tenant_quota_denied', bot: ctx.bot && ctx.bot.name });
      return send(res, 403, { error: 'operator_required' });
    }
    const id = ctx.params.matches[1];
    if (!isValidTenantId(id)) return send(res, 404, { error: 'not_found' });
    const store = getTenantStore(gw);
    const tenant = store.get(id);
    if (!tenant) return send(res, 404, { error: 'not_found' });

    const quotas = getTenantQuotas(gw);

    if (req.method === 'PUT') {
      let body;
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch { return send(res, 400, { error: 'invalid_json' }); }
      const patch = {};
      if (body.maxDiskMb !== undefined) patch.maxDiskMb = body.maxDiskMb;
      if (body.maxApiPerHour !== undefined) patch.maxApiPerHour = body.maxApiPerHour;
      let out;
      try {
        out = quotas.setQuota(tenant.id, patch);
      } catch (err) {
        if (err && err.code === 'invalid_quota') return send(res, 400, { error: 'invalid_quota' });
        throw err;
      }
      gw._audit({ type: 'tenant_quota_set', id: tenant.id, by: ctx.bot && ctx.bot.name });
      return send(res, 200, { ok: true, record: out.record });
    }

    if (req.method === 'GET') {
      const quota = quotas.getQuota(tenant.id);
      let disk = { ok: null, usedMb: null, limitMb: quota.maxDiskMb };
      let diskError = null;
      try {
        disk = quotas.checkDisk(tenant.id, store);
      } catch { diskError = 'usage_unavailable'; } // report limits regardless
      const count = quotas.peekApi(tenant.id);
      gw._audit({ type: 'tenant_quota_read', id: tenant.id, by: ctx.bot && ctx.bot.name });
      return send(res, 200, {
        tenant: tenant.id,
        quota: { maxDiskMb: quota.maxDiskMb, maxApiPerHour: quota.maxApiPerHour },
        usage: {
          disk: { usedMb: disk.usedMb, limitMb: disk.limitMb, ok: disk.ok, ...(diskError ? { error: diskError } : {}) },
          api: { count, limit: quota.maxApiPerHour, ok: count <= quota.maxApiPerHour },
        },
      });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
