// FS-W1 — tenant activity mounts. Operator-only.

const ta = require('../tenant-activity');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantActivity(gw) {
  gw.router.get('/v2/tenants/:id/activity', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_activity_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ta.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_activity_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/activity/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    const r = ta.getActivity(tenant);
    audit('tenant_activity_read', { by: op.name, tenant });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(r || { tenant, lastActivityAt: null, totalOps: 0 }));
  });

  gw.router.get('/v2/tenants/inactive', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_activity_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ta.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_activity_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const thresholdMs = url.searchParams.has('thresholdMs') ? Number(url.searchParams.get('thresholdMs')) : undefined;
    const rows = ta.listInactive(thresholdMs);
    audit('tenant_inactive_listed', { by: op.name, count: rows.length, thresholdMs: thresholdMs || 'default' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, inactive: rows }));
  });
};
