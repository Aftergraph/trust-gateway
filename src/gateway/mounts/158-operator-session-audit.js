// FS-Z7 — operator session audit mount. Operator-only.

const osa = require('../operator-session-audit');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountOperatorSessionAudit(gw) {
  gw.router.get('/v2/operator/sessions', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('op_session_audit_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!osa.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'operator_session_audit_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const target = url.searchParams.get('operator') || op.name;
    const limit = url.searchParams.get('limit');
    const sessions = osa.getSessions(target, limit);
    audit('op_session_audit_read', { by: op.name, target, count: sessions.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ operator: target, count: sessions.length, sessions }));
  });

  gw.router.get('/v2/operator/sessions/active', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('op_active_sessions_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!osa.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'operator_session_audit_disabled' }));
    }
    const active = osa.getActiveSessions();
    audit('op_active_sessions_read', { by: op.name, count: active.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: active.length, sessions: active }));
  });
};
