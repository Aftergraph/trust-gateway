// FS-W3 — operator notification preferences mounts. Operator-only.

const n = require('../operator-notify');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountOperatorNotify(gw) {
  gw.router.get('/v2/operator/notify', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!n.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'operator_notify_disabled' })); }
    const prefs = n.get(op.name);
    audit('operator_notify_read', { by: op.name, count: prefs.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: prefs.length, prefs }));
  });

  gw.router.put('/v2/operator/notify/:eventType', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!n.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'operator_notify_disabled' })); }
    const m = req.url.match(/^\/v2\/operator\/notify\/([^/]+)/);
    const eventType = m ? decodeURIComponent(m[1]) : null;
    if (!eventType) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_event' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const r = n.set(op.name, eventType, parsed.channel, parsed.enabled);
      if (!r) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'set_failed' })); }
      audit('operator_notify_set', { by: op.name, eventType, channel: parsed.channel || 'audit_chain', enabled: parsed.enabled !== false });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, eventType, channel: parsed.channel || 'audit_chain', enabled: parsed.enabled !== false }));
    });
  });

  gw.router.delete('/v2/operator/notify/:eventType/:channel', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!n.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'operator_notify_disabled' })); }
    const m = req.url.match(/^\/v2\/operator\/notify\/([^/]+)\/([^/]+)/);
    const eventType = m ? decodeURIComponent(m[1]) : null;
    const channel = m ? decodeURIComponent(m[2]) : null;
    if (!eventType || !channel) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_input' })); }
    const removed = n.remove(op.name, eventType, channel);
    audit('operator_notify_deleted', { by: op.name, eventType, channel, removed });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, removed }));
  });
};
