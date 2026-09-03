// FS-W2 — chain-prune real-execution mount. Operator-only.

const { prune, enabled } = require('../chain-prune');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountChainPrune(gw) {
  gw.router.post('/v2/chain/prune', async (req, res) => {
    const op = isOperator(req);
    if (!op) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'operator_required' })); }
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'chain_prune_disabled' })); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const beforeTs = Number(parsed.beforeTs);
      if (!Number.isFinite(beforeTs)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_before' })); }
      const r = prune(beforeTs, { force: !!parsed.force, by: op.name, reason: parsed.reason });
      if (!r.ok) {
        const code = r.error;
        const statusByCode = { below_safety_threshold: 409, invalid_before: 400, no_audit_chain: 500, prune_failed: 500 };
        audit('chain_prune_refused', { by: op.name, reason: code, current: r.current });
        res.statusCode = statusByCode[code] || 500;
        return res.end(JSON.stringify(r));
      }
      audit('chain_pruned', { by: op.name, removed: r.removed, beforeTs: r.beforeTs, manifestPath: r.manifestPath });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
};
