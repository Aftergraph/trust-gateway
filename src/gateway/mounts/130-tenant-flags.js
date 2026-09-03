// FS-N1 — tenant-scoped feature flag mounts. Operator-only.

const tf = require('../feature-flags-tenant');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantFlags(gw) {
  gw.router.get('/v2/tenants/:id/flags', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_flag_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tf.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'tenant_flags_disabled' })); }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/flags/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    const rows = tf.listForTenant(tenant);
    audit('tenant_flag_listed', { by: op.name, tenant, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tenant, count: rows.length, flags: rows }));
  });

  gw.router.put('/v2/tenants/:id/flags/:name', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_flag_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tf.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'tenant_flags_disabled' })); }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/flags\/([^/]+)/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    const name = m ? decodeURIComponent(m[2]) : null;
    if (!tenant || !name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_input' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const r = tf.set(name, { enabled: parsed.enabled, value: parsed.value }, op.name, tenant);
      audit('tenant_flag_set', { by: op.name, tenant, name, enabled: r.enabled, value: r.value });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.delete('/v2/tenants/:id/flags/:name', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_flag_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!tf.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'tenant_flags_disabled' })); }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/flags\/([^/]+)/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    const name = m ? decodeURIComponent(m[2]) : null;
    if (!tenant || !name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_input' })); }
    const removed = tf.reset(name, tenant);
    if (!removed) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('tenant_flag_reset', { by: op.name, tenant, name });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, tenant, name }));
  });
};
