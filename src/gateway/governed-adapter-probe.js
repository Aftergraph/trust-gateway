'use strict';

const crypto = require('node:crypto');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireContext(context = {}) {
  for (const key of [
    'requestId', 'correlationId', 'principalId', 'missionId',
    'authorityRef', 'purpose', 'credentialHandle',
  ]) {
    if (typeof context[key] !== 'string' || context[key].trim() === '') {
      throw fail('governed_adapter_context_required');
    }
  }
  return context;
}

function parseTarget(raw) {
  let target;
  try { target = new URL(String(raw || '')); } catch { throw fail('adapter_target_invalid'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw fail('adapter_target_scheme_invalid');
  }
  if (!target.hostname || target.username || target.password || target.hash) {
    throw fail('adapter_target_invalid');
  }
  if ([...target.searchParams].length > 0) {
    throw fail('adapter_query_auth_unsupported');
  }
  return {
    scheme: target.protocol.slice(0, -1),
    host: target.hostname.toLowerCase(),
    port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    path: target.pathname || '/',
    query: {},
  };
}

function bodyDigest(body) {
  return 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
}

function baseRequest(def, context, target, http) {
  return {
    requestId: context.requestId,
    correlationId: context.correlationId,
    principalId: context.principalId,
    missionId: context.missionId,
    authorityRef: context.authorityRef,
    purpose: context.purpose,
    credentialHandle: context.credentialHandle,
    destination: target,
    http,
    data: {
      sensitivity: ['adapter_probe'],
      provenanceRefs: ['adapter:' + String(def.id || 'unknown')],
      lineageId: 'adapter-probe:' + String(def.id || 'unknown'),
    },
  };
}

function buildWebhookProbeRequest(def, context = {}) {
  const ctx = requireContext(context);
  if (!def || def.kind !== 'webhook') throw fail('adapter_kind_invalid');
  const target = parseTarget(def.config?.url);
  const timestamp = String(ctx.now == null ? Date.now() : ctx.now);
  const body = JSON.stringify({ ping: true, ts: timestamp });
  return baseRequest(def, ctx, target, {
    method: 'POST',
    path: target.path,
    query: target.query,
    headers: { 'content-type': 'application/json' },
    body,
    bodyDigest: bodyDigest(body),
  });
}

function buildHttpApiProbeRequest(def, context = {}) {
  const ctx = requireContext(context);
  if (!def || def.kind !== 'http-api') throw fail('adapter_kind_invalid');
  if (def.config?.auth !== 'header') throw fail('adapter_query_auth_unsupported');
  const target = parseTarget(def.config?.baseUrl);
  return baseRequest(def, ctx, target, {
    method: 'GET',
    path: target.path,
    query: target.query,
    headers: { accept: 'application/json' },
  });
}

async function runGovernedAdapterProbe({ broker, request }) {
  if (!broker || typeof broker.admit !== 'function' || typeof broker.dispatch !== 'function') {
    throw fail('governed_egress_broker_required');
  }
  if (!request || typeof request !== 'object') throw fail('adapter_request_required');
  const admission = await broker.admit(request);
  return broker.dispatch(admission, request);
}

module.exports = {
  buildWebhookProbeRequest,
  buildHttpApiProbeRequest,
  runGovernedAdapterProbe,
};
