// FS-L2 — webhook subscription mounts. Operator-only.

const subs = require('../webhook-subs');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountWebhookSubs(gw) {
  gw.router.post('/v2/webhooks', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('webhook_subs_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'webhook_subs_disabled' }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_json' })); }
      try {
        const r = subs.create({ url: parsed.url, eventTypes: parsed.eventTypes, by: op.name });
        audit('webhook_subs_created', { by: op.name, id: r.id, url: r.url });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err.code || 'create_failed' }));
      }
    });
  });

  gw.router.get('/v2/webhooks', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('webhook_subs_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'webhook_subs_disabled' }));
    }
    const rows = subs.list();
    audit('webhook_subs_listed', { by: op.name, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, rows }));
  });

  gw.router.delete('/v2/webhooks/:id', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('webhook_subs_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!subs.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'webhook_subs_disabled' }));
    }
    const m = req.url.match(/^\/v2\/webhooks\/(\d+)/);
    const id = m ? Number(m[1]) : null;
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_id' })); }
    const removed = subs.remove(id);
    if (!removed) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('webhook_subs_deleted', { by: op.name, id });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, id }));
  });
};
