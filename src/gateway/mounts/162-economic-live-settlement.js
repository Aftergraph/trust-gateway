'use strict';

const { evaluateEconomicLiveSettlement } = require('../economic-live-settlement');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountEconomicLiveSettlement(gw) {
  gw.router.post('/v2/economic/live-settlement/check', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_json' }));
      }

      const result = evaluateEconomicLiveSettlement(parsed);
      audit('economic_live_settlement_admission_check', {
        by: op.name,
        mode: parsed.mode || null,
        lifecycle: parsed.lifecycle || null,
        allowed: result.allowed,
        decision: result.decision,
        reason: result.reason,
      });

      res.setHeader('Content-Type', 'application/json');
      res.statusCode = result.allowed ? 200 : 409;
      res.end(JSON.stringify(result));
    });
  });
};
