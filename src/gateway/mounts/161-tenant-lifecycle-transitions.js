// TG85 — tenant lifecycle transition endpoints (D-2026-09-10-01). Operator-only.
//
// The live enforcement seam for TG84 TEN-0.1 decision vectors: every state
// change passes through canTransitionTenant via the record store. Denials
// persist nothing and are audited.

const store = require('../tenant-lifecycle-store');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

function tenantIdFrom(url, suffix) {
  const m = String(url || '').match(new RegExp(`^/v2/tenants/([^/]+)/lifecycle${suffix}`));
  return m ? decodeURIComponent(m[1]) : null;
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* fail-closed: empty */ }
    cb(parsed);
  });
}

module.exports = function mountTenantLifecycleTransitions(gw) {
  gw.router.get('/v2/tenants/:id/lifecycle', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_lifecycle_read_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const tenantId = tenantIdFrom(req.url, '(?:/|$)');
    const rec = tenantId ? store.getRecord(tenantId) : null;
    if (!rec) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'missing_record' }));
    }
    audit('tenant_lifecycle_read', { by: op.name, tenant: tenantId, state: rec.state });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rec));
  });

  gw.router.post('/v2/tenants/:id/lifecycle/open', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_lifecycle_open_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const tenantId = tenantIdFrom(req.url, '/open');
    readBody(req, (parsed) => {
      const r = store.createRecord(tenantId, { requiredOwners: parsed.required_owners, actor: op.name });
      if (!r.ok) {
        const status = r.error === 'record_exists' ? 409 : 400;
        audit('tenant_lifecycle_open_failed', { by: op.name, tenant: tenantId, reason: r.error });
        res.statusCode = status;
        return res.end(JSON.stringify(r));
      }
      audit('tenant_lifecycle_opened', { by: op.name, tenant: tenantId });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.post('/v2/tenants/:id/lifecycle/transition', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_lifecycle_transition_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const tenantId = tenantIdFrom(req.url, '/transition');
    readBody(req, (parsed) => {
      const r = store.applyTransition(tenantId, parsed.to_state, op.name);
      if (!r.ok) {
        const status = r.error === 'missing_record' ? 404 : 409;
        audit('tenant_lifecycle_transition_denied', { by: op.name, tenant: tenantId, reason: r.error || r.reason });
        res.statusCode = status;
        return res.end(JSON.stringify(r));
      }
      audit('tenant_lifecycle_transitioned', { by: op.name, tenant: tenantId, state: r.record.state });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.post('/v2/tenants/:id/lifecycle/acks', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('tenant_lifecycle_ack_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const tenantId = tenantIdFrom(req.url, '/acks');
    readBody(req, (parsed) => {
      const r = store.recordAck(tenantId, { owner: parsed.owner, ack: parsed.ack });
      if (!r.ok) {
        const status = r.error === 'missing_record' ? 404 : 400;
        audit('tenant_lifecycle_ack_failed', { by: op.name, tenant: tenantId, reason: r.error });
        res.statusCode = status;
        return res.end(JSON.stringify(r));
      }
      audit('tenant_lifecycle_acked', { by: op.name, tenant: tenantId, owner: parsed.owner, ack: parsed.ack });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
};
