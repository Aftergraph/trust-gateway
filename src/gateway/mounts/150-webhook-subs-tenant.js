// FS-Y1 — per-tenant webhook subscription mounts. Operator-only.

const subs = require('../webhook-subs-tenant');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountWebhookSubsTenant(gw) {
  gw.router.post('/v2/tenants/:id/webhooks', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_webhook_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_webhook_subs_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/webhooks/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      try {
        const r = subs.create(tenant, parsed.url, parsed.eventTypes, op.name);
        audit('tenant_webhook_created', { by: op.name, tenant, id: r.id, url: r.url });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err.code || 'create_failed' }));
      }
    });
  });

  gw.router.get('/v2/tenants/:id/webhooks', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_webhook_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_webhook_subs_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/webhooks/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    const rows = subs.listForTenant(tenant);
    audit('tenant_webhook_listed', { by: op.name, tenant, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tenant, count: rows.length, webhooks: rows }));
  });

  gw.router.delete('/v2/tenants/:id/webhooks/:wid', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_webhook_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'tenant_webhook_subs_disabled' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/webhooks\/(\d+)/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    const wid = m ? Number(m[2]) : null;
    if (!tenant || !wid) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_input' })); }
    const removed = subs.remove(tenant, wid);
    if (!removed) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('tenant_webhook_deleted', { by: op.name, tenant, id: wid });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, id: wid }));
  });
};
