// FS-Z5 — audit export + retention mount. Operator-only.

const ae = require('../audit-export');
const { isOperator } = require('../tenants');
const { audit } = require('../events');
const fs = require('node:fs');

module.exports = function mountAuditExport(gw) {
  gw.router.get('/v2/audit/export', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('audit_export_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ae.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'audit_export_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const opts = {
      tenant: url.searchParams.get('tenant'),
      type: url.searchParams.get('type'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      limit: url.searchParams.get('limit'),
    };
    const result = ae.exportEvents(opts);
    audit('audit_exported', { by: op.name, count: result.count });
    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.jsonl"`);
    const stream = fs.createReadStream(result.file);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(result.file); } catch {} });
  });

  gw.router.post('/v2/audit/retention', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('audit_retention_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ae.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'audit_export_disabled' }));
    }
    const result = ae.applyRetention();
    audit('audit_retention_applied', { by: op.name, pruned: result.pruned });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
