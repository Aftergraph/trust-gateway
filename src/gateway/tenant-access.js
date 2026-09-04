'use strict';
// FS-A1 slice 3 — tenant selection for the operator console.
//
// GET /v2/tenants/accessible (operator-gated): lists id/name/disabled for
// the tenant picker. The console's chosen tenant rides the existing
// X-Tenant header (operator-only, honoured by tenant-resolve precedence
// rule 1). No new auth surface, no secrets in the listing.

const { getTenantStore, isOperator } = require('./tenants');
const { audit } = require('./events');

function mountTenantAccess(gw) {
  // Router facade may not exist on mountFiles:false gateways — build lazily.
  if (!gw.router) {
    gw.router = gw._makeRouter ? gw._makeRouter() : {};
    const routes = gw._fnRoutes || (gw._fnRoutes = []);
    const wire = (method) => (p, handler) => { routes.push({ method, path: p, handler }); };
    gw.router.get = wire('GET');
    gw.router.post = wire('POST');
    gw.router.put = wire('PUT');
    gw.router.delete = wire('DELETE');
    gw.router.patch = wire('PATCH');
    gw.router.all = wire('*');
  }
  gw.router.get('/v2/tenants/accessible', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_access_denied', { bot: (req.bot && req.bot.name) || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const store = getTenantStore(gw);
    const tenants = store.list().map(t => ({ id: t.id, name: t.name, disabled: !!t.disabled }));
    audit('tenant_access_listed', { by: op.name, count: tenants.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: tenants.length, tenants }));
  });
}

module.exports = { mountTenantAccess };
