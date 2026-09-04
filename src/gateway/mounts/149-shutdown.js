// FS-Y3 — graceful shutdown mount. Operator-only. Requires confirmation.

const { enabled, isDraining, drainStartedAt, beginDrain, scheduleExit } = require('../shutdown');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountShutdown(gw) {
  // GET — read state (idempotent, safe to poll)
  gw.router.get('/v2/shutdown', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'graceful_shutdown_disabled' })); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ draining: isDraining(), drainStartedAt: drainStartedAt() }));
  });

  // POST — begin drain + schedule exit
  gw.router.post('/v2/shutdown', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('graceful_shutdown_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'graceful_shutdown_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      if (parsed.confirm !== 'shutdown') {
        audit('graceful_shutdown_denied', { by: op.name, reason: 'missing_confirm' });
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'missing_confirm', required: 'shutdown' }));
      }
      if (isDraining()) {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: 'already_draining', drainStartedAt: drainStartedAt() }));
      }
      beginDrain();
      const ms = scheduleExit();
      audit('graceful_shutdown_initiated', { by: op.name, graceMs: ms });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, draining: true, graceMs: ms, drainStartedAt: drainStartedAt() }));
    });
  });
};
