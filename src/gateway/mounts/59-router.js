'use strict';
// v59 mount — Model Router HTTP surface (advisory, non-blocking)
// Exposes POST /v2/router/route for model selection based on constraints.

const { send } = require('../server');
const { getRegistry } = require('../providers-singleton');
const path = require('node:path');
const { RouterTelemetry } = require('../router-telemetry');
const { parsePolicyRouteRequest, selectPolicyRoute } = require('../model-route-policy');

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

    // ── POST /v2/router/outcome — telemetry recording (v0.2) ──
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

    // Policy-aware requests use only Trust-owned operational route metadata.
    // This branch is advisory/shadow-only: it selects and explains a route,
    // but does not dispatch a model or write Runtime/WORKS state.
    if (policyRequest.policyAware) {
      const selected = selectPolicyRoute({
        registryModels: reg.models(),
        request: { ...policyRequest.value, capability },
        telemetry,
      });
      if (selected.error) return send(res, 409, { error: selected.error });
      return send(res, 200, {
        model: selected.primary.model,
        provider: selected.primary.provider,
        fallbacks: selected.fallbacks,
      });
    }

    const budgetTier = String(body.budget_tier || 'standard').slice(0, 32);

    // Legacy routing path remains unchanged.
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
