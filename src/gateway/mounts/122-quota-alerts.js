// FS-K4 — quota alerts mount. Operator-only.

const { recentAlerts } = require('../quota-alerts');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountQuotaAlerts(gw) {
  gw.router.get('/v2/tenants/:id/quota/alerts', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('quota_alerts_read_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/quota\/alerts/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'missing_tenant' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
    const recent = recentAlerts(tenant, limit);
    audit('quota_alerts_read', { by: op.name, tenant, count: recent.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ recentAlerts: recent, count: recent.length }));
  });
};
