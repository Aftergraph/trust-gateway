'use strict';

const { classify, decide } = require('./policy');

const TOOL_KINDS = new Set(['http', 'cli', 'mcp', 'skill', 'browser', 'computer']);
const RUNTIMES = new Set(['gateway', 'runtime', 'relay', 'computer-node']);

function validateToolDescriptor(tool) {
  const errors = [];
  if (!tool || typeof tool !== 'object') return ['tool_descriptor_required'];
  if (tool.schemaVersion !== 'aftergraph.tool/v1') errors.push('unsupported_schema');
  if (!String(tool.id || '').trim()) errors.push('tool_id_required');
  if (!TOOL_KINDS.has(tool.kind)) errors.push('unsupported_tool_kind');
  if (!RUNTIMES.has(tool.runtime)) errors.push('unsupported_runtime');
  if (!Array.isArray(tool.capabilities) || tool.capabilities.length === 0) errors.push('capability_required');
  const bindings = Array.isArray(tool.credentialBindings) ? tool.credentialBindings : [];
  for (const binding of bindings) {
    if (binding && Object.keys(binding).some((key) => /value|token|password|secret|api.?key/i.test(key))) {
      errors.push('credential_material_forbidden');
    }
  }
  return errors;
}

function buildCredentialUsePlan(tool) {
  const errors = validateToolDescriptor(tool);
  if (errors.length) return { ok: false, errors };

  return {
    schemaVersion: 'aftergraph.credential-use-plan/v1',
    toolId: tool.id,
    bindings: (tool.credentialBindings || []).map((binding) => ({
      id: binding.id,
      mode: binding.mode,
      service: binding.service,
      scope: binding.scope || null,
      injectAs: binding.injectAs || 'provider_boundary',
      resolved: false,
    })),
    secretMaterialPresent: false,
    authorityGranted: false,
  };
}

function admitToolInvocation({ tool, capability, policyTool, bot }) {
  const errors = validateToolDescriptor(tool);
  if (errors.length) {
    return { admitted: false, decision: 'deny', reasons: errors, authorityGranted: false };
  }
  if (!tool.capabilities.includes(capability)) {
    return { admitted: false, decision: 'deny', reasons: ['capability_not_declared'], authorityGranted: false };
  }
  const cls = classify(policyTool);
  const policy = decide({ tool: policyTool, cls, bot });
  return {
    admitted: policy.decision === 'allow',
    decision: policy.decision,
    reasons: [policy.reason],
    classification: cls,
    toolId: tool.id,
    capability,
    authorityGranted: false,
    credentialUsePlan: buildCredentialUsePlan(tool),
  };
}



function bindToolCredentialHandle({
  tool,
  bindingId,
  credentialHandle,
  tenantId,
  adapterId,
  principalId,
  missionId,
  authorityRef,
  purpose,
} = {}) {
  const errors = validateToolDescriptor(tool);
  if (errors.length) throw Object.assign(new Error(errors[0]), { code: errors[0] });

  const binding = (tool.credentialBindings || []).find((item) => item && item.id === bindingId);
  if (!binding) throw Object.assign(new Error('credential_binding_unknown'), { code: 'credential_binding_unknown' });
  if (binding.mode === 'none') throw Object.assign(new Error('credential_binding_not_required'), { code: 'credential_binding_not_required' });

  for (const [name, value] of Object.entries({
    credentialHandle,
    tenantId,
    adapterId,
    principalId,
    missionId,
    authorityRef,
    purpose,
  })) {
    if (!String(value || '').trim()) {
      const code = 'tool_fabric_' + name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()) + '_required';
      throw Object.assign(new Error(code), { code });
    }
  }

  return Object.freeze({
    schemaVersion: 'aftergraph.tool-credential-binding/v1',
    toolId: tool.id,
    bindingId: binding.id,
    service: binding.service,
    mode: binding.mode,
    credentialHandle,
    tenantId,
    adapterId,
    principalId,
    missionId,
    authorityRef,
    purpose,
    secretMaterialPresent: false,
    authorityGranted: false,
  });
}

function toGovernedEgressRequest({ binding, invocation } = {}) {
  if (!binding || binding.schemaVersion !== 'aftergraph.tool-credential-binding/v1') {
    throw Object.assign(new Error('tool_credential_binding_required'), { code: 'tool_credential_binding_required' });
  }
  if (!invocation || typeof invocation !== 'object') {
    throw Object.assign(new Error('tool_invocation_required'), { code: 'tool_invocation_required' });
  }

  const resourceRef = 'adapter:' + binding.adapterId;
  return {
    ...invocation,
    tenantId: binding.tenantId,
    adapterId: binding.adapterId,
    principalId: binding.principalId,
    missionId: binding.missionId,
    authorityRef: binding.authorityRef,
    purpose: binding.purpose,
    credentialHandle: binding.credentialHandle,
    data: {
      ...(invocation.data || {}),
      resourceRef,
      provenanceRefs: [...new Set([...(invocation.data?.provenanceRefs || []), resourceRef])],
    },
  };
}

module.exports = { validateToolDescriptor, buildCredentialUsePlan, admitToolInvocation, bindToolCredentialHandle, toGovernedEgressRequest };
