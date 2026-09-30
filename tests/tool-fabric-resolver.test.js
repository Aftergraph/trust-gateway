'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  canonicalJson,
  verifyAggregateSnapshot,
  validatePolicyMap,
  FileToolFabricResolver,
} = require('../src/gateway/tool-fabric-resolver');

function sealedSnapshot(generatedAt = '2026-10-01T00:00:00.000Z') {
  const payload = {
    schemaVersion: 'aftergraph.tool-fabric-snapshot/v1',
    generatedAt,
    tools: [{
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
    }],
    observationCount: 2,
    federation: {
      schemaVersion: 'aftergraph.tool-federation-status/v1',
      healthy: true,
      sources: [],
      activeToolCount: 1,
      quarantinedSources: [],
      authorityGranted: false,
    },
    authorityGranted: false,
    credentialsExposed: false,
  };
  return {
    ...payload,
    snapshotDigest: crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex'),
  };
}

test('sealed snapshot verification matches CORE canonical JSON', () => {
  const snapshot = sealedSnapshot();
  assert.deepEqual(
    verifyAggregateSnapshot(snapshot, {
      now: Date.parse('2026-10-01T00:00:30.000Z'),
      maxAgeMs: 90_000,
    }),
    { valid: true, reasons: [] },
  );
});

test('sealed snapshot verification rejects tamper, stale and unhealthy federation', () => {
  const tampered = sealedSnapshot();
  tampered.observationCount = 99;
  assert.ok(verifyAggregateSnapshot(tampered, {
    now: Date.parse('2026-10-01T00:00:30.000Z'),
    maxAgeMs: 90_000,
  }).reasons.includes('snapshot_digest_mismatch'));

  const stale = sealedSnapshot('2026-10-01T00:00:00.000Z');
  assert.ok(verifyAggregateSnapshot(stale, {
    now: Date.parse('2026-10-01T00:02:00.000Z'),
    maxAgeMs: 90_000,
  }).reasons.includes('snapshot_stale'));

  const unhealthy = sealedSnapshot();
  unhealthy.federation.healthy = false;
  assert.ok(verifyAggregateSnapshot(unhealthy, {
    now: Date.parse('2026-10-01T00:00:30.000Z'),
    maxAgeMs: 90_000,
  }).reasons.includes('federation_unhealthy'));
});

test('policy map requires exact non-duplicated tool/capability entries', () => {
  assert.deepEqual(validatePolicyMap({
    schemaVersion: 'aftergraph.tool-policy-map/v1',
    entries: [{ toolId: 'github.read', capability: 'github.pr.read', policyTool: 'web.get' }],
  }), []);
  assert.ok(validatePolicyMap({
    schemaVersion: 'aftergraph.tool-policy-map/v1',
    entries: [
      { toolId: 'github.read', capability: 'github.pr.read', policyTool: 'web.get' },
      { toolId: 'github.read', capability: 'github.pr.read', policyTool: 'other' },
    ],
  }).includes('policy_map_entry_duplicate'));
});

test('file resolver resolves only sealed exact provenance with explicit policy mapping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-fabric-resolver-'));
  const snapshotPath = path.join(dir, 'snapshot.json');
  const policyMapPath = path.join(dir, 'policy-map.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(sealedSnapshot()), 'utf8');
  fs.writeFileSync(policyMapPath, JSON.stringify({
    schemaVersion: 'aftergraph.tool-policy-map/v1',
    entries: [{ toolId: 'github.read', capability: 'github.pr.read', policyTool: 'web.get' }],
  }), 'utf8');

  const resolver = new FileToolFabricResolver({
    snapshotPath,
    policyMapPath,
    maxAgeMs: 90_000,
    now: () => Date.parse('2026-10-01T00:00:30.000Z'),
  });

  const resolved = await resolver.resolve({
    toolId: 'github.read',
    capability: 'github.pr.read',
    provenanceDigest: 'a'.repeat(64),
  });
  assert.equal(resolved.tool.id, 'github.read');
  assert.equal(resolved.policyTool, 'web.get');

  assert.equal(await resolver.resolve({
    toolId: 'github.read',
    capability: 'github.pr.read',
    provenanceDigest: 'b'.repeat(64),
  }), null);
});
