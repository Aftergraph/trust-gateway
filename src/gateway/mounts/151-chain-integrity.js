// FS-Y2 — chain integrity check mount. Operator-only.

const ci = require('../chain-integrity');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountChainIntegrity(gw) {
  gw.router.get('/v2/chain/verify', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('chain_verify_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!ci.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'chain_integrity_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let result;
    if (from && to) {
      result = ci.verifyRange(Number(from), Number(to));
    } else {
      result = ci.verifyFull();
    }
    audit('chain_verified', { by: op.name, checked: result.checked, ok: result.ok, mismatches: result.mismatches.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
