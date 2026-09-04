// FS-Z2 — federation audit dashboard mount. Operator-only.

const fed = require('../fed-audit-dash');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountFedAuditDash(gw) {
  gw.router.get('/v2/federation/audit', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('fed_audit_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!fed.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'fed_audit_dash_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const opts = {
      type: url.searchParams.get('type'),
      tenant: url.searchParams.get('tenant'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    };
    const result = fed.query(opts);
    audit('fed_audit_queried', { by: op.name, total: result.total, returned: result.events.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });

  gw.router.get('/v2/federation/audit/summary', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('fed_audit_summary_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!fed.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'fed_audit_dash_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const windowMs = Number(url.searchParams.get('window')) || undefined;
    const result = fed.summary(windowMs);
    audit('fed_audit_summary_read', { by: op.name, totalEvents: result.totalEvents });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
