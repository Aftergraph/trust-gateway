'use strict';

const { evaluateToolActionRequest } = require('../tool-fabric-actions');
const { isOperator } = require('../tenants');
const { audit } = require('../events');

const MAX_BODY_BYTES = 64 * 1024;

module.exports = function mountToolFabricActions(gw) {
  gw.router.post('/v2/tool-fabric/actions/request', async (req, res) => {
    const op = isOperator(req);
    if (!op) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'operator_required' }));
    }

    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_BODY_BYTES) body += chunk;
    });
    req.on('end', async () => {
      if (bytes > MAX_BODY_BYTES) {
        res.statusCode = 413;
        return res.end(JSON.stringify({ error: 'request_too_large' }));
      }
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_json' }));
      }

      const evaluated = await evaluateToolActionRequest({
        request: parsed,
        resolver: gw.toolFabricResolver,
        bot: req.bot,
      });

      audit('tool_action_admission', {
        by: op.name,
        requestId: parsed?.requestId || null,
        toolId: parsed?.toolId || null,
        capability: parsed?.capability || null,
        missionId: parsed?.missionId || null,
        executionContextId: parsed?.executionContextId || null,
        decision: evaluated.body.decision,
        reasonCode: evaluated.body.reasonCode,
      });

      res.setHeader('Content-Type', 'application/json');
      res.statusCode = evaluated.status;
      res.end(JSON.stringify(evaluated.body));
    });
  });
};
