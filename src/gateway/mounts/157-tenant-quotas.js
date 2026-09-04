// FS-Z6 — tenant quota enforcement mount. Operator-only.

const tq = require('../tenant-quotas');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantQuotas(gw) {
  gw.router.get('/v2/tenants/:id/quota', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_quota_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tq.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_quotas_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/?]+)\/quota/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    const url = new URL(req.url, 'http://localhost');
    const resource = url.searchParams.get('resource');
    if (!resource) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_resource' })); }
    const quota = tq.getQuota(tenant, resource);
    const usage = tq.getUsage(tenant, resource);
    audit('tenant_quota_read', { by: op.name, tenant, resource });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ quota, usage }));
  });

  gw.router.put('/v2/tenants/:id/quota', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_quota_set_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tq.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_quotas_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/?]+)\/quota/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed.resource || typeof parsed.maxValue !== 'number') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_input' }));
        }
        const r = tq.setQuota(tenant, parsed.resource, parsed.maxValue);
        audit('tenant_quota_set', { by: op.name, tenant, resource: r.resource, maxValue: r.maxValue });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_json' }));
      }
    });
  });
};
