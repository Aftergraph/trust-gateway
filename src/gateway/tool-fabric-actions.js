'use strict';

const { admitToolInvocation } = require('./tool-fabric');

const HEX64 = /^[a-f0-9]{64}$/i;
const FORBIDDEN_KEYS = /value|token|password|secret|api.?key|credentialmaterial/i;

function validateToolActionRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return ['request_required'];
  if (request.schemaVersion !== 'aftergraph.tool-action-request/v1') errors.push('unsupported_schema');
  for (const field of ['requestId','toolId','capability','toolProvenanceDigest','principalId','missionId','executionContextId','idempotencyKey']) {
    if (!String(request[field] || '').trim()) errors.push(field + '_required');
  }
  if (request.toolProvenanceDigest && !HEX64.test(request.toolProvenanceDigest)) errors.push('tool_provenance_digest_invalid');
  if (request.argumentsDigest != null && !HEX64.test(request.argumentsDigest)) errors.push('arguments_digest_invalid');
  if (request.authorityGranted !== false) errors.push('authority_claim_forbidden');
  if (request.credentialMaterialPresent !== false) errors.push('credential_material_forbidden');
  if (Object.keys(request).some((key) => FORBIDDEN_KEYS.test(key) && key !== 'credentialMaterialPresent')) {
    errors.push('credential_field_forbidden');
  }
  return [...new Set(errors)];
}

async function evaluateToolActionRequest({ request, resolver, bot } = {}) {
  const errors = validateToolActionRequest(request);
  if (errors.length) return result(400, request, 'denied', errors[0], errors);
  if (!resolver || typeof resolver.resolve !== 'function') {
    return result(503, request, 'denied', 'resolver_unavailable', ['resolver_unavailable']);
  }

  let resolved;
  try {
    resolved = await resolver.resolve({
      toolId: request.toolId,
      capability: request.capability,
      provenanceDigest: request.toolProvenanceDigest,
    });
  } catch {
    return result(503, request, 'denied', 'resolver_failed', ['resolver_failed']);
  }

  if (!resolved || !resolved.tool) return result(409, request, 'denied', 'tool_resolution_failed', ['tool_resolution_failed']);
  const tool = resolved.tool;
  if (tool.id !== request.toolId) return result(409, request, 'denied', 'tool_identity_mismatch', ['tool_identity_mismatch']);
  if (tool.provenance?.digest !== request.toolProvenanceDigest) {
    return result(409, request, 'denied', 'tool_provenance_mismatch', ['tool_provenance_mismatch']);
  }
  if (!String(resolved.policyTool || '').trim()) {
    return result(409, request, 'denied', 'policy_mapping_missing', ['policy_mapping_missing']);
  }

  const admission = admitToolInvocation({
    tool,
    capability: request.capability,
    policyTool: resolved.policyTool,
    bot: bot || { capabilities: [] },
  });

  const decision = admission.decision === 'allow'
    ? 'admitted'
    : admission.decision === 'needs_approval'
      ? 'pending_approval'
      : 'denied';
  const status = decision === 'admitted' ? 200 : decision === 'pending_approval' ? 409 : 403;
  return {
    status,
    body: {
      schemaVersion: 'aftergraph.tool-action-admission/v1',
      requestId: request.requestId,
      toolId: request.toolId,
      capability: request.capability,
      decision,
      reasonCode: admission.reasons?.[0] || null,
      approvalId: null,
      classification: admission.classification || null,
      authorityGranted: false,
      credentialMaterialPresent: false,
      observedAt: new Date().toISOString(),
    },
  };
}

function result(status, request, decision, reasonCode, reasons) {
  return {
    status,
    body: {
      schemaVersion: 'aftergraph.tool-action-admission/v1',
      requestId: request?.requestId || null,
      toolId: request?.toolId || null,
      capability: request?.capability || null,
      decision,
      reasonCode,
      approvalId: null,
      reasons,
      authorityGranted: false,
      credentialMaterialPresent: false,
      observedAt: new Date().toISOString(),
    },
  };
}

module.exports = { validateToolActionRequest, evaluateToolActionRequest };
