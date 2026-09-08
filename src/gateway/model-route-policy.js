'use strict';

const { ROUTE_MODELS } = require('./model-route-catalog');

const POLICY_FIELDS = new Set([
  'execution_mode',
  'data_class',
  'provider_training_allowed',
  'max_cost_usd',
  'verification',
  'execution_context_id',
]);

const EXECUTION_MODES = new Set(['auto', 'verified']);
const DATA_CLASSES = new Set(['public', 'internal', 'confidential', 'restricted']);
const VERIFICATION_MODES = new Set(['exact_head']);
const ROUTABLE_CAPABILITIES = new Set(['code', 'reasoning', 'vision', 'multimodal']);
const EXECUTION_CONTEXT_RE = /^ctx_[a-f0-9]{32}$/;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPolicyAwareRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  for (const key of POLICY_FIELDS) {
    if (hasOwn(body, key)) return true;
  }
  return false;
}

function fail(error) {
  return { ok: false, status: 400, error };
}

function parsePolicyRouteRequest(body) {
  if (!isPolicyAwareRequest(body)) {
    return { ok: true, policyAware: false, value: null };
  }

  const executionMode = hasOwn(body, 'execution_mode') ? body.execution_mode : 'auto';
  if (typeof executionMode !== 'string' || !EXECUTION_MODES.has(executionMode)) {
    return fail('invalid_execution_mode');
  }

  if (!hasOwn(body, 'data_class')) return fail('data_class_required');
  if (typeof body.data_class !== 'string' || !DATA_CLASSES.has(body.data_class)) {
    return fail('invalid_data_class');
  }

  if (!hasOwn(body, 'provider_training_allowed')) {
    return fail('provider_training_allowed_required');
  }
  if (typeof body.provider_training_allowed !== 'boolean') {
    return fail('invalid_provider_training_allowed');
  }

  let maxCostUsd = null;
  if (hasOwn(body, 'max_cost_usd')) {
    if (typeof body.max_cost_usd !== 'number' || !Number.isFinite(body.max_cost_usd) || body.max_cost_usd < 0) {
      return fail('invalid_max_cost_usd');
    }
    maxCostUsd = body.max_cost_usd;
  }

  let executionContextId = null;
  if (hasOwn(body, 'execution_context_id')) {
    if (typeof body.execution_context_id !== 'string' || !EXECUTION_CONTEXT_RE.test(body.execution_context_id)) {
      return fail('invalid_execution_context_id');
    }
    executionContextId = body.execution_context_id;
  }

  let verification = null;
  if (hasOwn(body, 'verification')) {
    if (body.verification !== null &&
        (typeof body.verification !== 'string' || !VERIFICATION_MODES.has(body.verification))) {
      return fail('invalid_verification');
    }
    verification = body.verification;
  } else if (executionMode === 'verified' && String(body.capability || '') === 'code') {
    verification = 'exact_head';
  }

  return {
    ok: true,
    policyAware: true,
    value: {
      execution_mode: executionMode,
      data_class: body.data_class,
      provider_training_allowed: body.provider_training_allowed,
      max_cost_usd: maxCostUsd,
      verification,
      execution_context_id: executionContextId,
    },
  };
}

function selectPolicyRoute({ registryModels, request, telemetry = null } = {}) {
  const knownRegistryModels = new Set(
    Array.isArray(registryModels)
      ? registryModels.map((row) => `${row.provider}\u0000${row.model}`)
      : [],
  );
  const capability = ROUTABLE_CAPABILITIES.has(String(request?.capability || ''))
    ? String(request.capability)
    : null;
  const blacklisted = new Set(
    telemetry && typeof telemetry.blacklisted === 'function'
      ? telemetry.blacklisted()
      : [],
  );

  const candidates = ROUTE_MODELS
    .filter((row) => knownRegistryModels.has(`${row.provider}\u0000${row.model}`))
    .filter((row) => {
      if (row.dataUse !== 'provider_training') return true;
      if (request?.data_class === 'restricted') return false;
      return request?.provider_training_allowed === true;
    })
    .filter((row) => !capability || row.capabilities.includes(capability))
    .filter((row) => !blacklisted.has(row.provider))
    .map((row) => ({
      row,
      // V0.2 shadow budget proxy only: price for 1 MTok input + 1 MTok output.
      // Actual per-work execution cost belongs to Runtime/WORKS in later waves.
      comparisonCostUsd: row.pricing.inputPerMtokUsd + row.pricing.outputPerMtokUsd,
    }))
    .filter(({ comparisonCostUsd }) =>
      request?.max_cost_usd == null || comparisonCostUsd <= request.max_cost_usd,
    )
    .sort((a, b) =>
      a.comparisonCostUsd - b.comparisonCostUsd ||
      a.row.provider.localeCompare(b.row.provider) ||
      a.row.model.localeCompare(b.row.model),
    );

  if (candidates.length === 0) return { error: 'no_eligible_route' };

  const selected = candidates[0].row;
  const reasonCodes = ['cost_ranked', 'policy_eligible', 'provider_healthy'];
  reasonCodes.push(
    selected.dataUse === 'provider_training'
      ? 'provider_training_permitted'
      : 'no_provider_training_route',
  );
  if (capability) reasonCodes.push('capability_match');
  reasonCodes.sort();

  return {
    primary: { provider: selected.provider, model: selected.model },
    fallbacks: candidates.slice(1, 4).map(({ row }) => ({ provider: row.provider, model: row.model })),
    reasonCodes,
  };
}

module.exports = {
  POLICY_FIELDS,
  EXECUTION_MODES,
  DATA_CLASSES,
  VERIFICATION_MODES,
  isPolicyAwareRequest,
  parsePolicyRouteRequest,
  selectPolicyRoute,
};
