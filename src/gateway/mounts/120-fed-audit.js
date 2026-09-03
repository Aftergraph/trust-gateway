'use strict';
// FS-K1 — federation real-run audit dashboard mount.
// GET /v2/federation/audit — operator-only, returns listFederatedRuns(filters).
// Inert (404) when TG_SKILLS_FEDERATION unset.

const { listFederatedRuns, federationEnabled } = require('../fed-audit');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountFedAudit(gw) {
  gw.router.get('/v2/federation/audit', async (req, res) => {
    if (!federationEnabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'federation_disabled' }));
    }
    const op = isOperator(req);
    if (!op) {
      audit('federation_audit_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const filters = {
      owner: url.searchParams.get('owner') || undefined,
      runner: url.searchParams.get('runner') || undefined,
      skillId: url.searchParams.get('skillId') || undefined,
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      status: url.searchParams.get('status') || undefined,
    };
    const result = listFederatedRuns(filters);
    audit('federation_audit_read', { by: op.name, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
