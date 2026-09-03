// FS-K2 — tenant-scoped telemetry mount. Operator-only.
// GET /v2/tenants/:id/telemetry — returns payloadSummary-projected events.

const { getTenantEvents, enabled } = require('../telemetry-tenant');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantTelemetry(gw) {
  gw.router.get('/v2/tenants/:id/telemetry', async (req, res) => {
    if (!enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'telemetry_tenant_scoped_disabled' }));
    }
    const op = isOperator(req);
    if (!op) {
      audit('telemetry_tenant_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/telemetry/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'missing_tenant' }));
    }
    // Cross-tenant refusal: 404 anti-enumeration
    if (op.tenant && op.tenant !== tenant) {
      audit('telemetry_tenant_denied', { bot: op.name, tenant, reason: 'cross_tenant' });
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'not_found' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const filters = {
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.has('until') ? Number(url.searchParams.get('until')) : undefined,
      type: url.searchParams.get('type') || undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    };
    const result = getTenantEvents(tenant, filters);
    audit('telemetry_tenant_read', { by: op.name, tenant, count: result.count });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
