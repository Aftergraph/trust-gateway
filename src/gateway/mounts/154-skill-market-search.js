// FS-Z3 — skill marketplace search/filter mount. Operator-only.

const sm = require('../skill-market-search');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountSkillMarketSearch(gw) {
  gw.router.get('/v2/skills/search', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      audit('skill_search_denied', { bot: req.bot?.name || 'anonymous', reason: 'not_operator' });
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }
    if (!sm.enabled()) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'skill_market_search_disabled' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const opts = {
      q: url.searchParams.get('q'),
      tag: url.searchParams.get('tag'),
      visibility: url.searchParams.get('visibility'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    };
    const result = sm.search(opts);
    audit('skill_searched', { by: op.name, total: result.total, returned: result.skills.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
};
