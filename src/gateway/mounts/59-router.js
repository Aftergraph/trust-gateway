'use strict';
// v59 mount — Model Router HTTP surface (advisory, non-blocking)
// Exposes POST /v2/router/route for model selection based on constraints.

const { send } = require('../server');
const { getRegistry } = require('../providers-singleton');
const path = require('node:path');
const { RouterTelemetry } = require('../router-telemetry');
const {
  parsePolicyRouteRequest,
  selectPolicyRoute,
  createRouteReceipt,
} = require('../model-route-policy');

module.exports = {
  name: 'v2-router',
  method: 'POST',
  path: /^\/v2\/router\/(route|outcome)$/,
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

    if (!gw._routerTelemetry) {
      gw._routerTelemetry = new RouterTelemetry({
        file: process.env.TG_ROUTER_TELEMETRY || path.join(process.cwd(), 'data', 'router-telemetry.json'),
      });
    }
    const telemetry = gw._routerTelemetry;

    if (ctx.url.pathname.endsWith('/outcome')) {
      const { provider, model, ok, latency_ms } = body;
      if (!provider || !model) return send(res, 400, { error: 'provider_and_model_required' });
      if (typeof ok !== 'boolean') return send(res, 400, { error: 'ok_boolean_required' });
      const ev = telemetry.record({ provider, model, ok, latency_ms });
      gw._audit({ type: 'router_outcome_recorded', provider, model, ok });
      return send(res, 200, { ok: true, recorded: ev, health: telemetry.health() });
    }

    const policyRequest = parsePolicyRouteRequest(body);
    if (!policyRequest.ok) {
      return send(res, policyRequest.status, { error: policyRequest.error });
    }

    const capability = String(body.capability || '').slice(0, 64);
    const reg = getRegistry(gw);

    if (policyRequest.policyAware) {
      const routingRequest = { ...policyRequest.value, capability };
      const selected = selectPolicyRoute({
        registryModels: reg.models(),
        request: routingRequest,
        telemetry,
      });
      if (selected.error) return send(res, 409, { error: selected.error });

      const receipt = createRouteReceipt({
        request: routingRequest,
        selected: selected.primary,
        reasonCodes: selected.reasonCodes,
      });

      gw._audit({
        type: 'model_route_policy',
        routeId: receipt.route_id,
        executionMode: routingRequest.execution_mode,
        dataClass: routingRequest.data_class,
        trainingAllowed: routingRequest.provider_training_allowed,
        primaryProvider: selected.primary.provider,
        primaryModel: selected.primary.model,
        fallbackCount: selected.fallbacks.length,
        reasonCodes: receipt.selection.reason_codes,
      });

      return send(res, 200, {
        model: selected.primary.model,
        provider: selected.primary.provider,
        fallbacks: selected.fallbacks,
        receipt,
      });
    }

    const budgetTier = String(body.budget_tier || 'standard').slice(0, 32);

    const preferFree = budgetTier === 'free' || budgetTier === 'economy';
    const maxLanes = budgetTier === 'premium' ? 10 : 5;

    let plan;
    try {
      plan = reg.plan({ task: capability || 'general', preferFree, maxLanes });
    } catch (e) {
      return send(res, 500, { error: 'routing_failed', detail: String(e.message) });
    }

    const fallbacks = telemetry.reorderFallbacks(
      plan.fallbacks.slice(0, 3).map(({ model, provider }) => ({ model, provider })),
    );
    const result = {
      model: plan.primary.model,
      provider: plan.primary.provider,
      fallbacks,
    };

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
