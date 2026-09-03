// FS-X3 — per-route rate limits mounts. Operator-only.

const rl = require('../route-limits');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountRouteLimits(gw) {
  gw.router.put('/v2/rate/limits', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!rl.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'route_limits_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const r = rl.set(parsed.pattern, { maxHits: parsed.maxHits, windowMs: parsed.windowMs }, op.name);
      if (!r || !r.ok) { res.statusCode = 400; return res.end(JSON.stringify(r || { error: 'set_failed' })); }
      audit('route_limit_set', { by: op.name, pattern: r.pattern, maxHits: r.maxHits, windowMs: r.windowMs });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.get('/v2/rate/limits', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!rl.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'route_limits_disabled' })); }
    const rows = rl.list();
    audit('route_limit_listed', { by: op.name, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, limits: rows }));
  });

  gw.router.delete('/v2/rate/limits/:pattern', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!rl.enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'route_limits_disabled' })); }
    const m = req.url.match(/^\/v2\/rate\/limits\/(.+)/);
    const pattern = m ? decodeURIComponent(m[1]) : null;
    if (!pattern) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_pattern' })); }
    const removed = rl.remove(pattern);
    audit('route_limit_removed', { by: op.name, pattern, removed });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, removed }));
  });
};
