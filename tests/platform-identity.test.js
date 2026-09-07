'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const TENANT_SCHEMA = path.join(ROOT, 'docs', 'contracts', 'tenant', '1.0.json');
const PLATFORM_IDENTITY_MODULE = '../src/gateway/platform-identity';
const ORG_A = 'org_0123456789abcdef0123456789abcdef';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-platform-id-'));
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  return dir;
}

function resetModules() {
  for (const mod of [
    '../src/gateway/platform-identity',
    '../src/gateway/db',
    '../src/gateway/tenants',
    '../src/gateway/tenant-resolve',
    '../src/gateway/server',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* module may be intentionally absent in RED */ }
  }
}

function loadPlatformIdentity() {
  return require(PLATFORM_IDENTITY_MODULE);
}

function makeGateway() {
  const { Gateway } = require('../src/gateway/server');
  return new Gateway({
    bots: {
      worker: { token: 'worker-token', role: 'worker', capabilities: ['fs.read'] },
      operator: { token: 'operator-token', role: 'operator', capabilities: ['approval.decide'] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

function canonicalId(prefix, value) {
  assert.match(value, new RegExp(`^${prefix}_[a-f0-9]{32}$`));
}

test('tenant/1.0 schema exists and is strict', () => {
  assert.equal(fs.existsSync(TENANT_SCHEMA), true, 'tenant/1.0 schema is not implemented');
  const schema = JSON.parse(fs.readFileSync(TENANT_SCHEMA, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema', 'organization_id', 'tenant_id', 'status']);
  assert.equal(schema.properties.schema.const, 'tenant/1.0');
  assert.equal(schema.properties.organization_id.pattern, '^org_[a-f0-9]{32}$');
  assert.equal(schema.properties.tenant_id.pattern, '^ten_[a-f0-9]{32}$');
});

test('same local tenant binding is durable across gateway/db restart', () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  let api = loadPlatformIdentity();
  const first = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  canonicalId('ten', first.tenant_id);
  assert.equal(first.organization_id, ORG_A);

  require('../src/gateway/db').closeDb();
  resetModules();
  api = loadPlatformIdentity();
  const second = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  assert.equal(second.tenant_id, first.tenant_id);
  assert.equal(second.organization_id, ORG_A);
});

test('same external identity is stable in one tenant and distinct across tenants', () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const api = loadPlatformIdentity();
  const tenantA = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  const tenantB = api.ensureTenantBinding({ localTenantId: 'other', organizationId: ORG_A });

  const a1 = api.ensurePrincipalBinding({ tenantId: tenantA.tenant_id, identityRef: 'user:u_deadbeef', principalType: 'human' });
  const a2 = api.ensurePrincipalBinding({ tenantId: tenantA.tenant_id, identityRef: 'user:u_deadbeef', principalType: 'human' });
  const b = api.ensurePrincipalBinding({ tenantId: tenantB.tenant_id, identityRef: 'user:u_deadbeef', principalType: 'human' });

  canonicalId('prn', a1.principal_id);
  assert.equal(a2.principal_id, a1.principal_id);
  assert.notEqual(b.principal_id, a1.principal_id);
});

test('new canonical tenant binding fails closed without a valid organization id', () => {
  freshDb();
  delete process.env.TG_PLATFORM_ORG_ID;
  resetModules();
  const api = loadPlatformIdentity();
  assert.throws(
    () => api.ensureTenantBinding({ localTenantId: 'main', organizationId: undefined }),
    /organization/i,
  );
  assert.throws(
    () => api.ensureTenantBinding({ localTenantId: 'main', organizationId: 'org_short' }),
    /organization/i,
  );
});

test('existing canonical tenant binding remains readable if org env later disappears', () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  let api = loadPlatformIdentity();
  const first = api.ensureTenantBinding({ localTenantId: 'main', organizationId: ORG_A });
  delete process.env.TG_PLATFORM_ORG_ID;
  const second = api.ensureTenantBinding({ localTenantId: 'main', organizationId: undefined });
  assert.equal(second.tenant_id, first.tenant_id);
  assert.equal(second.organization_id, ORG_A);
});

test('/v2/platform/identity projects session user as human and no authority-bearing fields', async () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const gw = makeGateway();
  gw._currentUser = () => ({ id: 'u_deadbeef', role: 'member', disabled: false });
  const srv = await startGateway(gw);
  try {
    const res = await fetch(`${srv.base}/v2/platform/identity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema, 'platform-identity-projection/1.0');
    assert.equal(body.organization_id, ORG_A);
    canonicalId('ten', body.tenant_id);
    canonicalId('prn', body.principal_id);
    assert.equal(body.principal_type, 'human');
    assert.deepEqual(Object.keys(body).sort(), [
      'organization_id', 'principal_id', 'principal_type', 'schema', 'tenant_id',
    ]);
    for (const forbidden of ['authority_lease_id', 'capabilities', 'approval_rights', 'execution_token', 'worker_lease_id']) {
      assert.equal(Object.hasOwn(body, forbidden), false, `${forbidden} must never be projected`);
    }
  } finally {
    await srv.close();
    require('../src/gateway/db').closeDb();
  }
});

test('/v2/platform/identity projects bearer bot as agent while /v2/whoami stays legacy-compatible', async () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const gw = makeGateway();
  const srv = await startGateway(gw);
  try {
    const whoBefore = await (await fetch(`${srv.base}/v2/whoami`, { headers: { authorization: 'Bearer worker-token' } })).json();
    const res = await fetch(`${srv.base}/v2/platform/identity`, { headers: { authorization: 'Bearer worker-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.principal_type, 'agent');
    canonicalId('prn', body.principal_id);
    const whoAfter = await (await fetch(`${srv.base}/v2/whoami`, { headers: { authorization: 'Bearer worker-token' } })).json();
    assert.deepEqual(whoAfter, whoBefore, '/v2/whoami must remain unchanged');
  } finally {
    await srv.close();
    require('../src/gateway/db').closeDb();
  }
});

test('/v2/platform/identity preserves anti-enumeration for unknown explicit tenant', async () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const gw = makeGateway();
  const srv = await startGateway(gw);
  try {
    const res = await fetch(`${srv.base}/v2/platform/identity`, {
      headers: {
        authorization: 'Bearer operator-token',
        'x-tenant': 'does-not-exist',
      },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    await srv.close();
    require('../src/gateway/db').closeDb();
  }
});

test('/v2/platform/identity keeps serving the last-known org binding when the org env later disappears (readable-after-env-loss contract)', async () => {
  freshDb();
  process.env.TG_PLATFORM_ORG_ID = ORG_A;
  resetModules();
  const gw = makeGateway();
  const srv = await startGateway(gw);
  try {
    // Seed a binding while the org env is present (mirrors the direct-call contract test
    // 'existing canonical tenant binding remains readable if org env later disappears').
    const before = await fetch(`${srv.base}/v2/platform/identity`, { headers: { authorization: 'Bearer worker-token' } });
    assert.equal(before.status, 200);
    delete process.env.TG_PLATFORM_ORG_ID;
    const legacy = await fetch(`${srv.base}/v2/whoami`, { headers: { authorization: 'Bearer worker-token' } });
    assert.equal(legacy.status, 200);
    // Contract: an existing canonical binding stays readable — the projection serves the
    // last-known organization_id rather than failing closed. (Fails closed only when NO
    // binding exists at all, covered by the anti-enumeration + not-found tests above.)
    const platform = await fetch(`${srv.base}/v2/platform/identity`, { headers: { authorization: 'Bearer worker-token' } });
    assert.equal(platform.status, 200);
    const body = await platform.json();
    assert.equal(body.organization_id, ORG_A);
    canonicalId('ten', body.tenant_id);
    canonicalId('prn', body.principal_id);
  } finally {
    await srv.close();
    require('../src/gateway/db').closeDb();
  }
});
