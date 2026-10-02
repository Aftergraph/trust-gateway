'use strict';

/**
 * Bind an AIE execution-policy request to an already-issued Trust Gateway
 * admission result. This is glue only: it never upgrades a denied/pending
 * admission and never infers authority from a skill, model, tool or runtime.
 */
function bindExecutionPolicyAdmission({ planningRequest, toolAdmission } = {}) {
  const errors = [];

  if (!planningRequest || typeof planningRequest !== 'object') errors.push('planning_request_required');
  if (!toolAdmission || typeof toolAdmission !== 'object') errors.push('tool_admission_required');
  if (errors.length) return denied(errors[0], errors);

  if (planningRequest.schema !== 'aftergraph.execution-policy-request/v1') {
    errors.push('planning_schema_unsupported');
  }
  if (toolAdmission.schemaVersion !== 'aftergraph.tool-action-admission/v1') {
    errors.push('admission_schema_unsupported');
  }

  const capability = String(planningRequest.capability || '').trim();
  if (!capability) errors.push('capability_required');
  if (capability && capability !== String(toolAdmission.capability || '').trim()) {
    errors.push('capability_mismatch');
  }

  if (!String(planningRequest.authority_ref || '').trim()) {
    errors.push('authority_ref_required');
  }

  if (toolAdmission.decision !== 'admitted') {
    errors.push(toolAdmission.decision === 'pending_approval'
      ? 'approval_required'
      : 'tool_action_not_admitted');
  }

  if (errors.length) return denied(errors[0], errors);

  return {
    status: 200,
    body: {
      schemaVersion: 'aftergraph.execution-policy-admission/v1',
      admitted: true,
      authorityRef: planningRequest.authority_ref,
      requestId: toolAdmission.requestId || null,
      capability,
      environment: planningRequest.environment,
      effectClass: planningRequest.effect_class,
      uncertainty: planningRequest.uncertainty,
      structuredStateAvailable: planningRequest.structured_state_available === true,
      visionAvailable: planningRequest.vision_available === true,
      semanticReasoningRequired: planningRequest.semantic_reasoning_required === true,
      latencyBudgetMs: planningRequest.latency_budget_ms ?? null,
      authorityGranted: false,
      observedAt: new Date().toISOString(),
    },
  };
}

function denied(reasonCode, reasons = [reasonCode]) {
  return {
    status: reasonCode === 'approval_required' ? 409 : 403,
    body: {
      schemaVersion: 'aftergraph.execution-policy-admission/v1',
      admitted: false,
      reasonCode,
      reasons: [...new Set(reasons)],
      authorityGranted: false,
      observedAt: new Date().toISOString(),
    },
  };
}

module.exports = { bindExecutionPolicyAdmission };
