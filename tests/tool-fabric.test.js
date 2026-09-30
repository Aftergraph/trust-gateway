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
