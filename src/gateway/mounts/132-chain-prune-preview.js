// FS-N3 — chain-prune preview mount. Operator-only.

const { preview, enabled } = require('../chain-prune-preview');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountChainPrunePreview(gw) {
  gw.router.get('/v2/chain/prune-preview', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('chain_prune_preview_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!enabled()) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'chain_prune_preview_disabled' })); }
    const url = new URL(req.url, 'http://localhost');
    const beforeIso = url.searchParams.get('before');
    const beforeTs = beforeIso ? Date.parse(beforeIso) : NaN;
    if (!Number.isFinite(beforeTs)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'invalid_before' }));
    }
    const r = preview(beforeTs);
    if (!r) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'preview_failed' })); }
    audit('chain_prune_preview_read', { by: op.name, beforeTs, wouldRemove: r.wouldRemove });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(r));
  });
};
