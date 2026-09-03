// FS-L3 — feature flag mounts. Operator-only.

const flags = require('../feature-flags');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountFeatureFlags(gw) {
  gw.router.get('/v2/flags', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('flag_list_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const rows = flags.list();
    audit('flag_listed', { by: op.name, count: rows.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: rows.length, flags: rows }));
  });

  gw.router.put('/v2/flags/:name', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('flag_set_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const m = req.url.match(/^\/v2\/flags\/([^/]+)/);
    const name = m ? decodeURIComponent(m[1]) : null;
    if (!name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_name' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_json' })); }
      const r = flags.set(name, { enabled: parsed.enabled, value: parsed.value }, op.name);
      audit('flag_set', { by: op.name, name, enabled: r.enabled, value: r.value });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });

  gw.router.delete('/v2/flags/:name', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('flag_reset_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    const m = req.url.match(/^\/v2\/flags\/([^/]+)/);
    const name = m ? decodeURIComponent(m[1]) : null;
    if (!name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing_name' })); }
    const removed = flags.reset(name);
    if (!removed) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    audit('flag_reset', { by: op.name, name });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, name }));
  });
};
