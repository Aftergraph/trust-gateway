'use strict';
// v59 mount — Model Router HTTP surface (advisory, non-blocking)
// Exposes POST /v2/router/route for model selection based on constraints.

const { send } = require('../server');
const { getRegistry } = require('../providers-singleton');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RouterTelemetry } = require('../router-telemetry');

// ── Verified Auto Phase 0: advisory policy fields (backward compatible) ──
// New fields only narrow eligibility, never widen it. Restrictive data
// policy fails closed: confidential/restricted cannot be proven eligible
// without provider terms + processing metadata (not yet in the registry),
// so they are denied explicitly rather than silently treated as public.

const EXECUTION_MODES = new Set(['auto', 'verified']);
const DATA_CLASSES = new Set(['public', 'internal', 'confidential', 'restricted']);

const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function parsePolicy(body) {
  const policy = {};
  if (body.execution_mode !== undefined) {
    if (!EXECUTION_MODES.has(body.execution_mode)) {
      return { error: 'invalid_execution_mode' };
    }
    policy.execution_mode = body.execution_mode;
  }
  if (body.data_class !== undefined) {
    if (!DATA_CLASSES.has(body.data_class)) {
      return { error: 'invalid_data_class' };
    }
    policy.data_class = body.data_class;
  }
  if (body.provider_training_allowed !== undefined) {
    if (typeof body.provider_training_allowed !== 'boolean') {
      return { error: 'invalid_provider_training_allowed' };
    }
    policy.provider_training_allowed = body.provider_training_allowed;
  }
  if (body.max_cost_usd !== undefined) {
    if (!isNonNegativeNumber(body.max_cost_usd)) {
      return { error: 'invalid_max_cost_usd' };
    }
    policy.max_cost_usd = body.max_cost_usd;
  }
  if (body.verification !== undefined) {
    if (typeof body.verification !== 'string' || body.verification.length === 0 || body.verification.length > 64) {
      return { error: 'invalid_verification' };
    }
    policy.verification = body.verification;
  }
  if (body.execution_context_id !== undefined) {
    if (typeof body.execution_context_id !== 'string' || body.execution_context_id.length === 0 || body.execution_context_id.length > 128) {
      return { error: 'invalid_execution_context_id' };
    }
    policy.execution_context_id = body.execution_context_id;
  }
  return { policy };
}

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

    const capability = String(body.capability || '').slice(0, 64);
    const budgetTier = String(body.budget_tier || 'standard').slice(0, 32);

    // Verified Auto policy: malformed restrictive fields fail closed.
    const { policy, error: policyError } = parsePolicy(body);
    if (policyError) return send(res, 400, { error: policyError });

    // Restrictive data classes fail closed until provider terms +
    // processing metadata can prove an eligible route.
    if (policy.data_class === 'confidential' || policy.data_class === 'restricted') {
      gw._audit({ type: 'model_route_denied', reason: 'route_policy_denied', dataClass: policy.data_class });
      return send(res, 403, {
        error: 'route_policy_denied',
        reason: 'confidential_restricted_require_proven_private_processing',
      });
    }

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
    const fallbacks = telemetry.reorderFallbacks(
      plan.fallbacks.slice(0, 3).map(({ model, provider }) => ({ model, provider })),
    );
    const executionMode = policy.execution_mode || 'auto';
    const reasonCodes = ['capability_match', 'budget_match'];
    if (fallbacks.length > 0 || plan.primary) reasonCodes.push('provider_healthy');
    if (policy.max_cost_usd !== undefined) reasonCodes.push('cost_ceiling_recorded_unenforced');
    if (policy.provider_training_allowed !== undefined) {
      reasonCodes.push('training_policy_unevaluated_no_terms_metadata');
    }
    const receipt = {
      schema: 'model-route/1.0',
      route_id: `rte_${randomUUID().replace(/-/g, '')}`,
      provider: plan.primary.provider,
      model: plan.primary.model,
      capability: capability || 'general',
      execution_mode: executionMode,
      verification_required: executionMode === 'verified',
      reason_codes: reasonCodes,
      issued_at: new Date().toISOString(),
    };
    if (policy.data_class !== undefined) receipt.data_class = policy.data_class;
    if (policy.provider_training_allowed !== undefined) {
      receipt.provider_training_allowed = policy.provider_training_allowed;
    }
    if (policy.max_cost_usd !== undefined) receipt.max_cost_usd = policy.max_cost_usd;
    if (policy.verification !== undefined) receipt.verification = policy.verification;
    if (policy.execution_context_id !== undefined) {
      receipt.execution_context_id = policy.execution_context_id;
    }
    const result = {
      model: plan.primary.model,
      provider: plan.primary.provider,
      fallbacks,
      receipt,
    };

    // Audit routing decision (no capability text to avoid secrets)
    gw._audit({
      type: 'model_route',
      capabilityTag: capability || 'general',
      budgetTier,
      primaryProvider: result.provider,
      fallbackCount: result.fallbacks.length,
      executionMode,
      verificationRequired: receipt.verification_required,
      routeId: receipt.route_id,
    });

    return send(res, 200, result);
  },
};
