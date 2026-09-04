'use strict';
// v59 mount — Model Router HTTP surface (advisory, non-blocking)
// Exposes POST /v2/router/route for model selection based on constraints.

const { send } = require('../server');
const { getRegistry } = require('../providers-singleton');

module.exports = {
  name: 'v2-router',
  method: 'POST',
  path: '/v2/router/route',
  auth: 'bearer',
  handle: async (gw, req, res, ctx) => {
    let body;
    try {
      const raw = await (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      })();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }

    const capability = String(body.capability || '').slice(0, 64);
    const budgetTier = String(body.budget_tier || 'standard').slice(0, 32);

    // Build routing constraints
    const preferFree = budgetTier === 'free' || budgetTier === 'economy';
    const maxLanes = budgetTier === 'premium' ? 10 : 5;

    const reg = getRegistry(gw);
    let plan;
    try {
      plan = reg.plan({ task: capability || 'general', preferFree, maxLanes });
    } catch (e) {
      return send(res, 500, { error: 'routing_failed', detail: String(e.message) });
    }

    // Build response with primary and fallbacks
    const result = {
      model: plan.primary.model,
      provider: plan.primary.provider,
      fallbacks: plan.fallbacks.slice(0, 3).map(({ model, provider }) => ({ model, provider })),
    };

    // Audit routing decision (no capability text to avoid secrets)
    gw._audit({
      type: 'model_route',
      capabilityTag: capability || 'general',
      budgetTier,
      primaryProvider: result.provider,
      fallbackCount: result.fallbacks.length,
    });

    return send(res, 200, result);
  },
};
