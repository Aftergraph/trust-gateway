// FS-O2 — tenant impersonation mounts. Operator-only.

const imp = require('../tenant-impersonation');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountTenantImpersonation(gw) {
  gw.router.post('/v2/tenants/:id/impersonate', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!imp.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'impersonation_disabled' })); }
    const m = req.url.match(/^\/v2\/tenants\/([^/]+)\/impersonate/);
    const tenant = m ? decodeURIComponent(m[1]) : null;
    if (!tenant) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_tenant' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const ttl = Number.isFinite(parsed.ttlMs) ? parsed.ttlMs : 15 * 60 * 1000;
      if (ttl > 60 * 60 * 1000) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'ttl_too_long' })); }
      const r = imp.issue(op.name, tenant, ttl, parsed.reason);
      if (!r) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'issue_failed' })); }
      audit('impersonation_issued', { by: op.name, targetTenant: tenant, expiresAt: r.expiresAt, reason: parsed.reason });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.post('/v2/impersonation/:token/revoke', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!imp.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'impersonation_disabled' })); }
    const m = req.url.match(/^\/v2\/impersonation\/([^/]+)\/revoke/);
    const token = m ? decodeURIComponent(m[1]) : null;
    if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_token' })); }
    const removed = imp.revoke(token, 'manual');
    audit('impersonation_revoked', { by: op.name, token: token.slice(0, 8) + '...', removed });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, removed }));
  });

  gw.router.get('/v2/impersonation/active', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!imp.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'impersonation_disabled' })); }
    const rows = imp.listActive();
    // Strip full tokens from response (show only first 8 chars)
    const safe = rows.map(r => ({ ...r, token: r.token.slice(0, 8) + '...' }));
    audit('impersonation_listed', { by: op.name, count: safe.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: safe.length, tokens: safe }));
  });
};
