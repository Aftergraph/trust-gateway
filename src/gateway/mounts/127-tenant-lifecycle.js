// FS-M1 — tenant lifecycle mounts. Operator-only.

const lifecycle = require('../tenant-lifecycle');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantLifecycle(gw) {
  gw.router.get('/v2/tenants/cleanup-candidates', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_cleanup_candidates_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const candidates = lifecycle.cleanupOrphanedTenants();
    audit('tenant_cleanup_candidates_read', { by: op.name, count: candidates.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: candidates.length, candidates }));
  });

  gw.router.post('/v2/tenants/:id/auto-disable', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_auto_disable_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/auto-disable/);
    const tenantId = m ? decodeURIComponent(m[1]) : null;
    if (!tenantId) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const r = lifecycle.markAutoDisabled(tenantId, parsed.reason, op.name);
      if (!r.ok) {
        const statusByCode = { missing_tenant: 400, missing_reason: 400, reason_too_long: 400, update_failed: 500 };
        audit('tenant_auto_disable_failed', { bot: op.name, tenant: tenantId, reason: r.error });
        res.statusCode = statusByCode[r.error] || 500;
        return res.end(JSON.stringify(r));
      }
      audit('tenant_auto_disabled', { by: op.name, tenant: tenantId, reason: parsed.reason, at: r.disabledAt });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
};
