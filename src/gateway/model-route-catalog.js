'use strict';

// Trust-owned operational metadata for policy-aware model routing.
// This catalog describes third-party execution routes; it is NOT the
// Aftergraph model lifecycle registry and does not promote/champion models.
// Pricing and data-use terms are point-in-time routing inputs and must be
// re-verified before public/commercial claims are made from them.

const ROUTE_MODELS = Object.freeze([
  Object.freeze({
    provider: 'meta-model-api',
    model: 'muse-spark-1.3-contributor',
    external: true,
    capabilities: Object.freeze(['code', 'reasoning', 'vision', 'multimodal']),
    dataUse: 'provider_training',
    retention: 'terms_governed',
    pricing: Object.freeze({
      currency: 'USD',
      inputPerMtokUsd: 0.10,
      outputPerMtokUsd: 0.20,
      cacheReadPerMtokUsd: 0.002,
      snapshotDate: '2026-09-08',
    }),
    sourceCheckedAt: '2026-09-08',
  }),
  Object.freeze({
    provider: 'meta-model-api',
    model: 'muse-spark-1.3',
    external: true,
    capabilities: Object.freeze(['code', 'reasoning', 'vision', 'multimodal']),
    dataUse: 'no_provider_training',
    retention: 'terms_governed',
    pricing: Object.freeze({
      currency: 'USD',
      inputPerMtokUsd: 1.25,
      outputPerMtokUsd: 4.25,
      cacheReadPerMtokUsd: 0.15,
      snapshotDate: '2026-09-08',
    }),
    sourceCheckedAt: '2026-09-08',
  }),
]);

function getRouteModel(provider, model) {
  const providerId = String(provider || '');
  const modelId = String(model || '');
  return ROUTE_MODELS.find((row) => row.provider === providerId && row.model === modelId) || null;
}

module.exports = { ROUTE_MODELS, getRouteModel };
