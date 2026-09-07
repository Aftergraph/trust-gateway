'use strict';

// Capability conformance: TG policy.js ROLE_CAPABILITIES must equal the
// governed mirror (Aftergraph/after-graph-governance
// docs/contracts/capability/1.0.json, mirrored into
// docs/contracts/capability/1.0.json here). Change the code and the
// mirror together via a governance-first PR; this test breaks loudly
// on silent drift either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIRROR = path.join(__dirname, '..', 'docs', 'contracts', 'capability', '1.0.json');

test('capability mirror exists and pins the exact role map', () => {
  assert.equal(fs.existsSync(MIRROR), true);
  const contract = JSON.parse(fs.readFileSync(MIRROR, 'utf8'));
  const { ROLE_CAPABILITIES } = require('../src/gateway/policy');
  assert.deepEqual(ROLE_CAPABILITIES, contract.properties.role_capabilities.default);
});

test('unknown roles fall back to least privilege, never wildcard', () => {
  const { capabilitiesFor } = require('../src/gateway/policy');
  assert.deepEqual(capabilitiesFor('nonexistent-role'), ['fs.read', 'web.get']);
  assert.ok(!capabilitiesFor('nonexistent-role').includes('*'));
});

test('wildcard semantics match the contract', () => {
  const contract = JSON.parse(fs.readFileSync(MIRROR, 'utf8'));
  const ws = contract.properties.wildcard_semantics.properties;
  assert.equal(ws.full.const, '*');
  assert.ok(typeof ws.prefix.description === 'string' && ws.prefix.description.includes(':*'));
  assert.ok(typeof ws.exact.description === 'string');
});
