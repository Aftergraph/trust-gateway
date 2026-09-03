// FS-X1 — notification delivery test endpoint (operator-only).
// In production, deliver() is called from the audit pipeline.
// This mount lets an operator manually trigger a delivery for testing.

const { deliver, enabled } = require('../notify-delivery');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountNotifyDelivery(gw) {
  gw.router.post('/v2/notify/test', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'notify_delivery_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const eventType = parsed.type || 'test_event';
      const payload = parsed.payload || { test: true };
      try {
        const r = await deliver(eventType, payload, { bot: op.name });
        audit('notify_delivery_test', { by: op.name, type: eventType, delivered: r.delivered });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'delivery_failed', message: String(err.message || err) }));
      }
    });
  });
};
