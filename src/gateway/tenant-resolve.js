'use strict';
// FS-E1 slice 1 — tenant resolver.
//
// resolveTenant(req, gw) → { tenant, source } with precedence:
//   1. explicit 'X-Tenant' header — honoured ONLY for operators (same gate
//      as canApprove: role operator/owner, capability 'approval.decide' or
//      '*'; a request may also set req.__tgOperator=true). A non-operator
//      header is IGNORED, never honoured and never leaked — it falls through
//      to the lower precedences.
//   2. bearer token tenant prefix on bot tokens: 'tnt_<tenantId>_<rest>'.
//      The prefix is an identity CLAIM, not an auth decision — bearer auth
//      itself stays where it is (slices 2-3 wire enforcement).
//   3. default: the auto-created 'main' tenant.
//
// ANTI-ENUMERATION: the resolver NEVER reveals whether a tenant exists to
// non-members. An unknown or disabled tenant on any route resolves to
// { tenant: null } and callers must answer 404 — never 403, never a
// tenant-specific error body. Secrets (token material) never appear in the
// return value or in any audit/chain payload this module produces.

const { getTenantStore, isValidTenantId } = require('./tenants');

// 'tnt_<tenantId>_<rest>' — tenantId is a strict slug, '_' is the separator
// (tenant ids themselves never contain '_').
const TNT_PREFIX_RE = /^tnt_([a-z0-9-]{3,24})_(.+)$/;

function isOperatorBot(bot) {
  if (!bot) return false;
  if (bot.role === 'operator' || bot.role === 'owner') return true;
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.includes('approval.decide') || caps.includes('*');
}

function resolveTenant(req, gw) {
  const store = getTenantStore(gw);
  const headers = (req && req.headers) || {};

  // 1. explicit X-Tenant header (operator only)
  const hdr = headers['x-tenant'];
  if (typeof hdr === 'string' && hdr.trim()) {
    const operator = isOperatorBot(req && req.bot) || (req && req.__tgOperator === true);
    if (operator) {
      const id = hdr.trim().toLowerCase();
      const t = isValidTenantId(id) ? store.get(id) : null;
      if (t && !t.disabled) return { tenant: t, source: 'header' };
      return { tenant: null, source: 'header' };
    }
    // not an operator: header is ignored — fall through, reveal nothing
  }

  // 2. bearer token tenant prefix
  const m = /^Bearer\s+(\S+)$/i.exec(headers['authorization'] || '');
  if (m) {
    const pm = TNT_PREFIX_RE.exec(m[1]);
    if (pm) {
      const t = store.get(pm[1]);
      if (t && !t.disabled) return { tenant: t, source: 'token' };
      return { tenant: null, source: 'token' };
    }
  }

  // 3. default 'main'
  const main = store.ensureMain();
  if (!main || main.disabled) return { tenant: null, source: 'default' };
  return { tenant: main, source: 'default' };
}

module.exports = { resolveTenant, isOperatorBot, TNT_PREFIX_RE };
