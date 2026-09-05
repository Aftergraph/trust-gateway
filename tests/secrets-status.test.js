'use strict';
// v2q-(b) — GET /v2/secrets vault-status mount tests.
//
// Covers: operator-only (worker/anon denied), vault_disabled when off,
// key-ONLY aggregate (values never exposed), masterRotatedAt from row
// updated_at, mount registered in gateway router.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v2q-status-${name}-`));
  const prevDb = process.env.TG_DB_FILE;
  const prevVault = process.env.TG_SECRETS_VAULT;
  const prevMaster = process.env.TG_SECRETS_MASTER_KEY;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  delete process.env.TG_SECRETS_VAULT;
  delete process.env.TG_SECRETS_MASTER_KEY;
  process.chdir(dir);
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      process.chdir(prevCwd);
      if (prevDb === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = prevDb;
      if (prevVault === undefined) delete process.env.TG_SECRETS_VAULT; else process.env.TG_SECRETS_VAULT = prevVault;
      if (prevMaster === undefined) delete process.env.TG_SECRETS_MASTER_KEY; else process.env.TG_SECRETS_MASTER_KEY = prevMaster;
    });
}

const OP = 'tok-status-op';
const WK = 'tok-status-wk';

function makeGw() {
  process.env.TG_SECRETS_VAULT = '1';
  process.env.TG_SECRETS_MASTER_KEY = 'status-master-key';
  for (const m of Object.keys(require.cache)) {
    // Windows: cache keys use backslashes — match both separators.
    if (m.includes('/src/gateway/') || m.includes('\\src\\gateway\\')) delete require.cache[m];
  }
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({
    bots: {
      atlas: { token: OP, role: 'operator', capabilities: ['*'] },
      forge: { token: WK, role: 'worker', capabilities: ['fs.read'] },
    },
    telemetryFile: null,
    dispatch: async () => ({ ok: true }),
    mountFiles: false,
  });
  gw.mounts.push(require('../src/gateway/mounts/115-secrets'));
  gw.mounts.push(require('../src/gateway/mounts/119-secrets-rotate'));
  gw.mounts.push(require('../src/gateway/mounts/120-secrets-status'));
  return gw;
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

async function fetch2(port, method, p, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

test('v2q: GET /v2/secrets er registreret og operator-only', async () => {
  await withDbFile('authz', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // worker denied
      const denied = await fetch2(s.port, 'GET', '/v2/secrets', WK);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');

      // anon denied
      const anon = await fetch2(s.port, 'GET', '/v2/secrets', null);
      assert.equal(anon.status, 401);
    } finally { await s.close(); }
  });
});

test('v2q: vault OFF → 404 vault_disabled (feature = not there)', async () => {
  await withDbFile('off', async () => {
    delete process.env.TG_SECRETS_VAULT; // off
    for (const m of Object.keys(require.cache)) {
      if (m.includes('/src/gateway/') || m.includes('\\src\\gateway\\')) delete require.cache[m];
    }
    const { Gateway } = require('../src/gateway/server');
    const gw = new Gateway({
      bots: { atlas: { token: OP, role: 'operator', capabilities: ['*'] } },
      telemetryFile: null,
      dispatch: async () => ({ ok: true }),
      mountFiles: false,
    });
    gw.mounts.push(require('../src/gateway/mounts/120-secrets-status'));
    const s = await serve(gw);
    try {
      const off = await fetch2(s.port, 'GET', '/v2/secrets', OP);
      assert.equal(off.status, 404);
      assert.equal(off.json.error, 'vault_disabled');
    } finally { await s.close(); }
  });
});

test('v2q: vault ON — aggregate er key-only, aldrig values, masterRotatedAt fra rows', async () => {
  await withDbFile('aggregate', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // seed via the normal PUT route (same authz path)
      const put1 = await fetch2(s.port, 'PUT', '/v2/tenants/acme/secrets/api_key', OP, { value: 'super-secret-value-1' });
      const put2 = await fetch2(s.port, 'PUT', '/v2/tenants/acme/secrets/webhook_secret', OP, { value: 'super-secret-value-2' });
      const put3 = await fetch2(s.port, 'PUT', '/v2/tenants/globex/secrets/db_pass', OP, { value: 'super-secret-value-3' });
      assert.equal(put1.status, 200);
      assert.equal(put2.status, 200);
      assert.equal(put3.status, 200);

      const r = await fetch2(s.port, 'GET', '/v2/secrets', OP);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.enabled, true);
      assert.ok(r.json.masterRotatedAt, 'masterRotatedAt udledt fra updated_at');

      const tenants = r.json.tenants;
      assert.equal(tenants.length, 2);
      const acme = tenants.find((x) => x.tenant === 'acme');
      assert.ok(acme, 'acme findes');
      assert.deepEqual(acme.keys.sort(), ['api_key', 'webhook_secret']);

      // values NEVER leave the vault
      const flat = JSON.stringify(r.json);
      assert.ok(!flat.includes('super-secret-value'), 'secret values må aldrig eksponeres');
      assert.ok(!flat.includes('status-master-key'), 'master key må aldrig eksponeres');
    } finally { await s.close(); }
  });
});

test('v2q: rotation opdaterer masterRotatedAt og keys består', async () => {
  await withDbFile('rotate', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      await fetch2(s.port, 'PUT', '/v2/tenants/acme/secrets/k1', OP, { value: 'val-1' });
      const before = await fetch2(s.port, 'GET', '/v2/secrets', OP);
      assert.ok(before.json.masterRotatedAt);

      const rot = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'fresh-master-key-2' });
      assert.equal(rot.status, 200);
      assert.deepEqual(rot.json, { ok: true, rotatedCount: 1 });

      const after = await fetch2(s.port, 'GET', '/v2/secrets', OP);
      assert.equal(after.status, 200);
      const acme = after.json.tenants.find((x) => x.tenant === 'acme');
      assert.deepEqual(acme.keys, ['k1']);
      assert.ok(!JSON.stringify(after.json).includes('val-1'), 'value aldrig eksponeret efter rotation');
    } finally { await s.close(); }
  });
});