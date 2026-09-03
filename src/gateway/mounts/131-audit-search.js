// FS-N2 — operator audit-log search mount. Operator-only.

const search = require('../audit-search');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountAuditSearch(gw) {
  gw.router.get('/v2/audit/search', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('audit_search_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!search.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'audit_search_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const filters = {
      type: url.searchParams.get('type') || undefined,
      bot: url.searchParams.get('bot') || undefined,
      tenant: url.searchParams.get('tenant') || undefined,
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.has('until') ? Number(url.searchParams.get('until')) : undefined,
      payloadHas: url.searchParams.get('payloadHas') || undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    };
    const rows = search.search(filters);
    const cnt = search.count(filters);
    audit('audit_search_read', { by: op.name, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)), count: cnt });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: cnt, rows }));
  });
};
