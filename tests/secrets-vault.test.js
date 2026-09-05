'use strict';
// FS-I5 — tenant-scoped secrets vault tests.
//
// Covers: set/get roundtrip, per-tenant isolation (A never reads B's values,
// including the same key name), list returns KEYS not values (and never any
// plaintext anywhere in the response), delete semantics, env-off = inert
// (throw-on-write, null/[]/false on reads — byte-identical legacy), master-key
// rotation renders old secrets honestly unreadable (null, not garbage), the
// operator mount (PUT/GET/DELETE, worker 403 + secret_denied audit, anonymous
// 401, key-only GET, value never exposed), and restart persistence with the
// same TG_DB_FILE + TG_SECRETS_MASTER_KEY.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fs-i5-${name}-`));
  const prevDb = process.env.TG_DB_FILE;
  const prevVault = process.env.TG_SECRETS_VAULT;
  const prevMaster = process.env.TG_SECRETS_MASTER_KEY;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  delete process.env.TG_SECRETS_VAULT;
  delete process.env.TG_SECRETS_MASTER_KEY;
  process.chdir(dir);
  // Async-aware: await the fn result BEFORE restoring env/cwd (a sync
  // finally would restore env while the async test body is still running).
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      process.chdir(prevCwd);
      if (prevDb === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = prevDb;
      if (prevVault === undefined) delete process.env.TG_SECRETS_VAULT; else process.env.TG_SECRETS_VAULT = prevVault;
      if (prevMaster === undefined) delete process.env.TG_SECRETS_MASTER_KEY; else process.env.TG_SECRETS_MASTER_KEY = prevMaster;
    });
}

// Fresh module graph per case: db.js is a process singleton, so bust the
// require cache for the whole gateway module set AFTER the env is set.
// Module exports are merged onto the result, so callers can destructure
// ({ SecretsVault } = freshModules([...])) — single file per call in practice.
function freshModules(files) {
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/src/gateway/') || m.includes('\\src\\gateway\\')) delete require.cache[m];
  }
  const out = {};
  for (const f of files) {
    const mod = require(path.isAbsolute(f) ? f : `../src/gateway/${f}`);
    Object.assign(out, mod);
    out[path.basename(f).replace(/\.js$/, '')] = mod;
  }
  return out;
}

const VAULT = require.resolve('../src/gateway/secrets-vault');

test('vault: env-off is inert (write throws, reads return null/[]/false) and table stays empty', () => {
  withDbFile('off', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV();
    assert.equal(v.enabled, false);
    assert.throws(() => v.setSecret('main', 'k', 'v'), /vault_disabled/);
    assert.equal(v.getSecret('main', 'k'), null);
    assert.deepEqual(v.listKeys('main'), []);
    assert.equal(v.deleteSecret('main', 'k'), false);

    // enabled flag but no master key also fails CLOSED on write
    const vm = new SV({ enabled: true, master: null });
    assert.throws(() => vm.setSecret('main', 'k', 'v'), /vault_master_key_missing/);
    assert.equal(vm.getSecret('main', 'k'), null);

    // nothing was stored
    const { db } = require('../src/gateway/db');
    const n = db.prepare("SELECT COUNT(*) AS n FROM tenant_secrets").get().n;
    assert.equal(n, 0);
  });
});

test('vault: set/get roundtrip; ciphertext at rest never contains plaintext; update overwrites', () => {
  withDbFile('roundtrip', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'test-master' });
    assert.equal(v.setSecret('main', 'openai-key', 'sk-super-secret-42'), true);
    assert.equal(v.getSecret('main', 'openai-key'), 'sk-super-secret-42');
    // update
    assert.equal(v.setSecret('main', 'openai-key', 'sk-rotated-99'), true);
    assert.equal(v.getSecret('main', 'openai-key'), 'sk-rotated-99');
    // at-rest honesty: raw cell is not the plaintext
    const { db } = require('../src/gateway/db');
    const row = db.prepare("SELECT value_enc, updated_at FROM tenant_secrets WHERE tenant='main' AND key='openai-key'").get();
    assert.ok(row.value_enc);
    assert.ok(!row.value_enc.includes('sk-rotated-99'));
    assert.ok(!row.value_enc.includes('sk-super-secret-42'));
    assert.ok(typeof row.updated_at === 'number');
    // missing key → null
    assert.equal(v.getSecret('main', 'nope'), null);
    // multi-line / unicode plaintext roundtrips
    v.setSecret('main', 'weird', 'line1\nline2\t→ü✓');
    assert.equal(v.getSecret('main', 'weird'), 'line1\nline2\t→ü✓');
  });
});

test('vault: per-tenant isolation — same key name, different tenants, different values', () => {
  withDbFile('isolation', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'iso-master' });
    v.setSecret('main', 'api-key', 'main-value');
    v.setSecret('acme-corp', 'api-key', 'acme-value');
    assert.equal(v.getSecret('main', 'api-key'), 'main-value');
    assert.equal(v.getSecret('acme-corp', 'api-key'), 'acme-value');
    // A cannot read B's secret and vice versa
    assert.notEqual(v.getSecret('main', 'api-key'), 'acme-value');
    assert.notEqual(v.getSecret('acme-corp', 'api-key'), 'main-value');
    // deleting in one tenant does not touch the other
    assert.equal(v.deleteSecret('main', 'api-key'), true);
    assert.equal(v.getSecret('main', 'api-key'), null);
    assert.equal(v.getSecret('acme-corp', 'api-key'), 'acme-value');
    // lists are scoped
    v.setSecret('acme-corp', 'b', 'bv');
    assert.deepEqual(v.listKeys('main'), []);
    assert.deepEqual(v.listKeys('acme-corp'), ['api-key', 'b']);
  });
});

test('vault: list returns keys only, never values; delete removes exactly once', () => {
  withDbFile('list-delete', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'ld-master' });
    v.setSecret('main', 'k1', 'value-ONE');
    v.setSecret('main', 'k2', 'value-TWO');
    const keys = v.listKeys('main');
    assert.deepEqual(keys, ['k1', 'k2']);
    for (const k of keys) assert.equal(typeof k, 'string');
    const raw = JSON.stringify(keys);
    assert.ok(!raw.includes('value-ONE') && !raw.includes('value-TWO'));
    assert.equal(v.deleteSecret('main', 'k1'), true);
    assert.equal(v.getSecret('main', 'k1'), null);
    assert.deepEqual(v.listKeys('main'), ['k2']);
    assert.equal(v.deleteSecret('main', 'k1'), false); // idempotent-absent
    // fail-closed tenant ids
    assert.throws(() => v.setSecret('../evil', 'k', 'v'), /invalid tenant/);
    assert.equal(v.getSecret('../evil', 'k'), null);
    assert.deepEqual(v.listKeys('../evil'), []);
    assert.equal(v.deleteSecret('../evil', 'k'), false);
  });
});

test('vault: restart persistence + master-key change renders old secrets honestly unreadable', () => {
  withDbFile('rotation', (dir) => {
    const dbFile = path.join(dir, 'gateway.db');
    let v;
    {
      const { SecretsVault: SV } = freshModules([VAULT]);
      v = new SV({ enabled: true, master: 'old-master' });
      v.setSecret('main', 'token', 'persist-me');
    }
    // reopen: same db file, same master → still readable
    {
      const { SecretsVault: SV } = freshModules([VAULT]);
      const v2 = new SV({ enabled: true, master: 'old-master' });
      assert.equal(v2.getSecret('main', 'token'), 'persist-me');
    }
    // rotate the master: row still EXISTS but decrypts to null — honest
    // failure (never garbage, never a silent wrong value)
    {
      const { SecretsVault: SV } = freshModules([VAULT]);
      const v3 = new SV({ enabled: true, master: 'new-master' });
      assert.equal(v3.getSecret('main', 'token'), null);
      assert.deepEqual(v3.listKeys('main'), ['token']); // key list survives
      // the old master still reads its own rows (cache keyed by master)
      const v4 = new SV({ enabled: true, master: 'old-master' });
      assert.equal(v4.getSecret('main', 'token'), 'persist-me');
      // re-set under the new master heals the row
      assert.equal(v3.setSecret('main', 'token', 're-encrypted'), true);
      assert.equal(v3.getSecret('main', 'token'), 're-encrypted');
      assert.equal(v4.getSecret('main', 'token'), null); // old master now locked out
    }
  });
});

// ── operator mount tests ────────────────────────────────────────────────────

const OP = 'tok-i5-op';
const WK = 'tok-i5-wk';

function makeGw(env) {
  process.env.TG_SECRETS_VAULT = '1';
  process.env.TG_SECRETS_MASTER_KEY = 'mount-master';
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/src/gateway/') || m.includes('\\src\\gateway\\')) delete require.cache[m];
  }
  console.error('MAKEGW cache cleared, secrets-vault cached?', !!require.cache[require.resolve('../src/gateway/secrets-vault')]);
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

// global fetch (undici) like tenant-scope.test.js — raw http.request keep-alive
// sockets would keep the closed server's handles alive between tests.
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

test('vault mount: operator PUT/GET/DELETE; GET is key-only; all four events audited', async () => {
  await withDbFile('mount', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const put = await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/slack-token', OP, { value: 'xoxb-live-1' });
      assert.equal(put.status, 200);
      assert.deepEqual(put.json, { ok: true, tenant: 'main', key: 'slack-token' });

      // value stored encrypted, readable only via internal getSecret
      const vault = gw.mounts.length && require('../src/gateway/secrets-vault').getSecretsVault(gw);
      assert.equal(vault.getSecret('main', 'slack-token'), 'xoxb-live-1');

      const put2 = await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/other', OP, { value: 'v2' });
      assert.equal(put2.status, 200);

      // GET list → keys only, never values
      const list = await fetch2(s.port, 'GET', '/v2/tenants/main/secrets', OP);
      assert.equal(list.status, 200);
      assert.deepEqual(Object.keys(list.json).sort(), ['keys']);
      assert.deepEqual(list.json.keys.sort(), ['other', 'slack-token']);
      assert.ok(!list.text.includes('xoxb-live-1') && !list.text.includes('v2-value'));

      // DELETE
      const del = await fetch2(s.port, 'DELETE', '/v2/tenants/main/secrets/other', OP);
      assert.equal(del.status, 200);
      assert.equal(del.json.ok, true);
      const delAgain = await fetch2(s.port, 'DELETE', '/v2/tenants/main/secrets/other', OP);
      assert.equal(delAgain.status, 404);
      const list2 = await fetch2(s.port, 'GET', '/v2/tenants/main/secrets', OP);
      assert.deepEqual(list2.json.keys, ['slack-token']);

      // no route reads a value back (GET with key → 405, value stays internal)
      const readAttempt = await fetch2(s.port, 'GET', '/v2/tenants/main/secrets/slack-token', OP);
      assert.equal(readAttempt.status, 405);

      // audit rows: exact key sets, never the value
      const types = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(types.includes('secret_set'));
      assert.ok(types.includes('secret_listed'));
      assert.ok(types.includes('secret_deleted'));
      const setRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'secret_set');
      assert.deepEqual(Object.keys(setRow).sort(), ['key', 'tenant', 'type']);
      assert.ok(!JSON.stringify(setRow).includes('xoxb'));
      const listRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'secret_listed');
      assert.deepEqual(Object.keys(listRow).sort(), ['tenant', 'type']);
      const delRow = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'secret_deleted');
      assert.deepEqual(Object.keys(delRow).sort(), ['key', 'tenant', 'type']);
    } finally { await s.close(); }
  });
});

test('vault mount: worker 403 + secret_denied audited; anonymous 401; disabled vault → 404', async () => {
  await withDbFile('mount-auth', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const denied = await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/k', WK, { value: 'x' });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');
      const deniedList = await fetch2(s.port, 'GET', '/v2/tenants/main/secrets', WK);
      assert.equal(deniedList.status, 403);
      const rows = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'secret_denied');
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.deepEqual(Object.keys(r).sort(), ['bot', 'type']);
        assert.equal(r.bot, 'forge');
      }
      const anon = await fetch2(s.port, 'GET', '/v2/tenants/main/secrets', null);
      assert.equal(anon.status, 401);
      // nothing leaked: no row was written by the refused calls
      const vault = require('../src/gateway/secrets-vault').getSecretsVault(gw);
      assert.deepEqual(vault.listKeys('main'), []);
    } finally { await s.close(); }

    // env off → mount answers 404 vault_disabled (feature off = not there)
    delete process.env.TG_SECRETS_VAULT;
    for (const m of Object.keys(require.cache)) {
      if (m.includes('/src/gateway/') || m.includes('\\src\\gateway\\')) delete require.cache[m];
    }
    const { Gateway } = require('../src/gateway/server');
    const gw2 = new Gateway({
      bots: { atlas: { token: OP, role: 'operator', capabilities: ['*'] } },
      telemetryFile: null,
      dispatch: async () => ({ ok: true }),
      mountFiles: false,
    });
    gw2.mounts.push(require('../src/gateway/mounts/115-secrets'));
    const s2 = await serve(gw2);
    try {
      const off = await fetch2(s2.port, 'PUT', '/v2/tenants/main/secrets/k', OP, { value: 'x' });
      assert.equal(off.status, 404);
      assert.equal(off.json.error, 'vault_disabled');
      const offList = await fetch2(s2.port, 'GET', '/v2/tenants/main/secrets', OP);
      assert.equal(offList.status, 404);
    } finally { await s2.close(); }
  });
});
