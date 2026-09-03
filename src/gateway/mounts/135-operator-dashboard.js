// FS-O3 — operator dashboard mount. Operator-only.

const dash = require('../operator-dashboard');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountOperatorDashboard(gw) {
  gw.router.get('/v2/dashboard', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('operator_dashboard_denied', { bot: req.bot?.name || 'anonymous' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!dash.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'operator_dashboard_disabled' }));
    }
    const d = dash.build();
    audit('operator_dashboard_read', { by: op.name, sections: Object.keys(d?.sections || {}) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(d));
  });
};
