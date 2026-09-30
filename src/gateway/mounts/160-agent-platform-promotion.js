'use strict';

const { evaluatePromotionRequest } = require('../agent-platform-promotion');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

module.exports = function mountAgentPlatformPromotion(gw) {
  gw.router.post('/v2/agent-platform/promotion/check', async (req, res) => {
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

      const result = evaluatePromotionRequest(parsed);
      audit('agent_platform_promotion_check', {
        by: op.name,
        eligible: result.eligible,
        decision: result.decision,
        candidateId: parsed?.candidate?.id || null,
        evidenceHash: parsed?.decision?.evidenceHash || parsed?.evidence?.evidenceDigest || null,
        reasons: result.reasons
      });

      res.setHeader('Content-Type', 'application/json');
      res.statusCode = result.eligible ? 200 : 409;
      res.end(JSON.stringify(result));
    });
  });
};
