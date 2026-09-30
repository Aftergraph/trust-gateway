'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolDescriptor, buildCredentialUsePlan, admitToolInvocation } = require('../src/gateway/tool-fabric');

const tool = {
  schemaVersion: 'aftergraph.tool/v1',
  id: 'github.read',
  version: '1.0.0',
  kind: 'http',
  capabilities: ['github.pr.read'],
  runtime: 'gateway',
  credentialBindings: [
    { id: 'github-oauth', mode: 'oauth', service: 'github.com', scope: 'repo', injectAs: 'provider_boundary' }
  ]
};

test('ToolFabric accepts reference-only credential bindings', () => {
  assert.deepEqual(validateToolDescriptor(tool), []);
  const plan = buildCredentialUsePlan(tool);
  assert.equal(plan.ok, undefined);
  assert.equal(plan.secretMaterialPresent, false);
  assert.equal(plan.authorityGranted, false);
  assert.equal(plan.bindings[0].resolved, false);
});

test('ToolFabric rejects credential material in descriptors', () => {
  const unsafe = {
    ...tool,
    credentialBindings: [{ id: 'x', mode: 'api_key', service: 'example', token: 'forbidden' }]
  };
  assert.ok(validateToolDescriptor(unsafe).includes('credential_material_forbidden'));
});

test('ToolFabric admission delegates to existing gateway policy and grants no authority', () => {
  const result = admitToolInvocation({
    tool,
    capability: 'github.pr.read',
    policyTool: 'web.get',
    bot: { capabilities: ['web.get'] }
  });
  assert.equal(result.admitted, true);
  assert.equal(result.decision, 'allow');
  assert.equal(result.authorityGranted, false);
  assert.equal(result.credentialUsePlan.secretMaterialPresent, false);
});

test('ToolFabric unknown policy surfaces fail closed', () => {
  const result = admitToolInvocation({
    tool,
    capability: 'github.pr.read',
    policyTool: 'unknown.effect',
    bot: { capabilities: ['*'] }
  });
  assert.equal(result.admitted, false);
  assert.equal(result.decision, 'needs_approval');
  assert.equal(result.classification, 'destructive');
});


test('ToolFabric binds opaque credential handles without secret material', () => {
  const { bindToolCredentialHandle, toGovernedEgressRequest } = require('../src/gateway/tool-fabric');
  const bound = bindToolCredentialHandle({
    tool,
    bindingId: 'github-oauth',
    credentialHandle: 'ch_opaque',
    tenantId: 'ten_main',
    adapterId: 'github',
    principalId: 'agent-1',
    missionId: 'mission-1',
    authorityRef: 'auth-1',
    purpose: 'github.pr.read',
  });
  assert.equal(bound.secretMaterialPresent, false);
  assert.equal(bound.authorityGranted, false);
  assert.equal(bound.credentialHandle, 'ch_opaque');
  assert.equal('secret' in bound, false);

  const request = toGovernedEgressRequest({
    binding: bound,
    invocation: {
      requestId: 'req-1',
      correlationId: 'corr-1',
      executionContextId: 'ctx-1',
      actionId: 'action-1',
      effectId: 'effect-1',
      effectClass: 'read',
      destination: { scheme: 'https', host: 'api.github.com', port: 443 },
      http: { method: 'GET', path: '/repos/Aftergraph/core/pulls/6', query: {}, headers: {}, bodyDigest: null },
      data: { sensitivity: [], provenanceRefs: [], lineageId: 'lin-1' }
    }
  });

  assert.equal(request.credentialHandle, 'ch_opaque');
  assert.equal(request.adapterId, 'github');
  assert.equal(request.data.resourceRef, 'adapter:github');
  assert.ok(request.data.provenanceRefs.includes('adapter:github'));
  assert.equal(JSON.stringify(request).includes('super-secret'), false);
});

test('ToolFabric refuses missing or none credential bindings', () => {
  const { bindToolCredentialHandle } = require('../src/gateway/tool-fabric');
  assert.throws(() => bindToolCredentialHandle({
    tool,
    bindingId: 'missing',
    credentialHandle: 'ch_opaque',
    tenantId: 'ten_main',
    adapterId: 'github',
    principalId: 'agent-1',
    missionId: 'mission-1',
    authorityRef: 'auth-1',
    purpose: 'github.pr.read',
  }), { code: 'credential_binding_unknown' });
});
