// FS-M3 — rate-limit bucket mounts. Operator-only.

const ledger = require('../rate-ledger');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountRateLedger(gw) {
  gw.router.get('/v2/rate/buckets/:key', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('rate_bucket_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ledger.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'rate_ledger_disabled' }));
    }
    const m = req.url.match(/^\/v2\/rate\/baskets\/([^/?]+)/);
    const key = m ? decodeURIComponent(m[1]) : null;
    if (!key) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_key' })); }
    const url = new URL(req.url, 'http://localhost');
    const windowMs = url.searchParams.has('windowMs') ? Number(url.searchParams.get('windowMs')) : 60_000;
    const count = ledger.getCount(key, windowMs);
    audit('rate_bucket_read', { by: op.name, key, count });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ key, count, windowMs, observedAt: Date.now() }));
  });

  gw.router.post('/v2/rate/buckets/:key/reset', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('rate_bucket_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ledger.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'rate_ledger_disabled' }));
    }
    const m = req.url.match(/^\/v2\/rate\/baskets\/([^/]+)\/reset/);
    const key = m ? decodeURIComponent(m[1]) : null;
    if (!key) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_key' })); }
    const removed = ledger.reset(key);
    audit('rate_bucket_reset', { by: op.name, key, removed });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, key, removed }));
  });
};
