// FS-Z1 — tenant metrics aggregates mount. Operator-only.

const tm = require('../tenant-metrics');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantMetrics(gw) {
  gw.router.get('/v2/metrics/tenant/:id', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_metrics_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tm.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_metrics_disabled' }));
    }
    const m = req.url.match(/^\/v2\/metrics\/tenant\/([^/?]+)/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    const url = new URL(req.url, 'http://localhost');
    const windowMs = Number(url.searchParams.get('window')) || undefined;
    const result = tm.getMetrics(tenant, windowMs);
    // Anti-enumeration: unknown/disabled tenant → 404, never 403 or empty 200
    if (!result) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'not_found' }));
    }
    audit('tenant_metrics_read', { by: op.name, tenant, totalEvents: result.totalEvents });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });

  gw.router.get('/v2/metrics/summary', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('metrics_summary_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tm.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_metrics_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const windowMs = Number(url.searchParams.get('window')) || undefined;
    const result = tm.getAllTenantsSummary(windowMs);
    audit('metrics_summary_read', { by: op.name, tenantCount: result.tenantCount });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
