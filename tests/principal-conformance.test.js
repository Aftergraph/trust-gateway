'use strict';

// Principal conformance: TG's canonical principal binding carries every
// semantic field AIE principal/1.0 requires. Naming correspondence is
// explicit (TG `principal_type` <-> contract `type`); the projection body
// served over HTTP is a separate surface and NOT asserted here.
// Mirror: docs/contracts/principal/1.0.json is a verbatim copy of
// Aftergraph/aie spec/contracts/principal/1.0.json (mirror, never edited).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRINCIPAL_SCHEMA = path.join(ROOT, 'docs', 'contracts', 'principal', '1.0.json');
const ORG_A = 'org_0123456789abcdef0123456789abcdef';

// AIE principal/1.0 required fields.
const REQUIRED = ['schema', 'principal_id', 'tenant_id', 'type', 'identity_ref', 'status'];

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-principal-conf-'));
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
}

function resetModules() {
  for (const mod of [
    '../src/gateway/platform-identity',
    '../src/gateway/db',
    '../src/gateway/tenants',
    '../src/gateway/tenant-resolve',
    '../src/gateway/server',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* absent in RED */ }
  }
}

function toContractShape(binding) {
  // ponytail: semantic mapping, not field equality — TG stores
  // principal_type where the contract names it type. The mapping lives
  // here in one place so a rename breaks loudly.
  return {
    schema: 'principal/1.0',
    principal_id: binding.principal_id,
    tenant_id: binding.tenant_id,
    type: binding.principal_type,
    identity_ref: binding.identity_ref,
    status: binding.status,
  };
}

function assertConforms(shape, schema) {
  for (const f of REQUIRED) assert.ok(f in shape, `missing ${f}`);
  assert.equal(schema.additionalProperties, false);
  assert.match(shape.principal_id, new RegExp(schema.properties.principal_id.pattern));
  assert.match(shape.tenant_id, new RegExp(schema.properties.tenant_id.pattern));
  assert.ok(schema.properties.type.enum.includes(shape.type));
  assert.ok(shape.identity_ref.length >= 1);
  assert.ok(schema.properties.status.enum.includes(shape.status));
}

test('principal/1.0 mirror exists and is strict', () => {
  assert.equal(fs.existsSync(PRINCIPAL_SCHEMA), true);
  const schema = JSON.parse(fs.readFileSync(PRINCIPAL_SCHEMA, 'utf8'));
  assert.deepEqual(schema.required, REQUIRED);
  assert.equal(schema.properties.schema.const, 'principal/1.0');
});

test('binding output conforms to principal/1.0 for every principal type', () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const api = require('../src/gateway/platform-identity');
  const schema = JSON.parse(fs.readFileSync(PRINCIPAL_SCHEMA, 'utf8'));
  const tenant = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  for (const t of ['human', 'agent', 'service', 'worker']) {
    const b = api.ensurePrincipalBinding({
      tenantId: tenant.tenant_id, identityRef: `user:u_${t}`, principalType: t,
    });
    assertConforms(toContractShape(b), schema);
  }
});

test('binding fails closed on invalid type and tenant', () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const api = require('../src/gateway/platform-identity');
  const tenant = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  assert.throws(() => api.ensurePrincipalBinding({
    tenantId: tenant.tenant_id, identityRef: 'user:x', principalType: 'superuser',
  }), /invalid principal_type/);
  assert.throws(() => api.ensurePrincipalBinding({
    tenantId: 'nope', identityRef: 'user:x', principalType: 'human',
  }), /invalid tenant_id/);
});
