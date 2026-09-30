'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolActionRequest, evaluateToolActionRequest } = require('../src/gateway/tool-fabric-actions');

const request = {
  schemaVersion: 'aftergraph.tool-action-request/v1',
  requestId: 'req-1',
  toolId: 'github.read',
  capability: 'github.pr.read',
  toolProvenanceDigest: 'a'.repeat(64),
  principalId: 'operator-1',
  missionId: 'mission-1',
  executionContextId: 'ctx-1',
  idempotencyKey: 'idem-1',
  argumentsDigest: null,
  authorityGranted: false,
  credentialMaterialPresent: false,
};

const tool = {
  schemaVersion: 'aftergraph.tool/v1',
  id: 'github.read',
  version: '1.0.0',
  kind: 'http',
  capabilities: ['github.pr.read'],
  runtime: 'gateway',
  credentialBindings: [],
  provenance: {
    source: 'Aftergraph/relay',
    revision: '1',
    digest: 'a'.repeat(64),
  },
};

test('HomeOS ToolFabric request validator forbids authority and credential material', () => {
  assert.deepEqual(validateToolActionRequest(request), []);
  assert.ok(validateToolActionRequest({ ...request, authorityGranted: true }).includes('authority_claim_forbidden'));
  assert.ok(validateToolActionRequest({ ...request, credentialMaterialPresent: true }).includes('credential_material_forbidden'));
  assert.ok(validateToolActionRequest({ ...request, apiKey: 'forbidden' }).includes('credential_field_forbidden'));
  assert.ok(validateToolActionRequest({ ...request, arguments: { raw: true } }).includes('unknown_request_field'));
  assert.ok(validateToolActionRequest({ ...request, requestId: '../unsafe' }).includes('request_id_invalid'));
  assert.ok(validateToolActionRequest({ ...request, idempotencyKey: 'bad/key' }).includes('idempotency_key_invalid'));
});

test('ToolFabric action admission resolves trusted descriptor and admits read-only policy', async () => {
  const resolver = {
    async resolve(input) {
      assert.equal(input.toolId, 'github.read');
      assert.equal(input.provenanceDigest, 'a'.repeat(64));
      return { tool, policyTool: 'web.get' };
    },
  };
  const result = await evaluateToolActionRequest({
    request,
    resolver,
    bot: { capabilities: ['web.get'] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.decision, 'admitted');
  assert.equal(result.body.authorityGranted, false);
  assert.equal(result.body.credentialMaterialPresent, false);
});

test('ToolFabric action admission fails closed without trusted resolver', async () => {
  const result = await evaluateToolActionRequest({
    request,
    resolver: null,
    bot: { capabilities: ['*'] },
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.decision, 'denied');
  assert.equal(result.body.reasonCode, 'resolver_unavailable');
});

test('ToolFabric action admission rejects stale or substituted provenance', async () => {
  const resolver = { async resolve() { return { tool: { ...tool, provenance: { ...tool.provenance, digest: 'b'.repeat(64) } }, policyTool: 'web.get' }; } };
  const result = await evaluateToolActionRequest({
    request,
    resolver,
    bot: { capabilities: ['web.get'] },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.reasonCode, 'tool_provenance_mismatch');
});

test('Unknown/consequential policy mapping remains needs-approval rather than auto-admit', async () => {
  const resolver = { async resolve() { return { tool, policyTool: 'unknown.effect' }; } };
  const result = await evaluateToolActionRequest({
    request,
    resolver,
    bot: { capabilities: ['*'] },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.decision, 'pending_approval');
  assert.equal(result.body.authorityGranted, false);
});
