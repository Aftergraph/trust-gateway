'use strict';
// FS-J2 — secrets master-key rotation tests.
//
// Covers: full rotation roundtrip (all rows re-encrypted under the new
// master, old master locked out), abort-on-single-failure (corrupt row →
// tx rollback, ZERO rows rotated, failure list names the row), same-key
// refused, weak-key refused, env-off inert, post-rotation get/set works
// with the new key, and the operator mount (operator-only, audited,
// vault_disabled / weak_key / same_key guards, new master never echoed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function withDbFile(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fs-j2-${name}-`));
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

// Fresh module graph per case (db.js is a process singleton).
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
const NEWKEY = 'rotated-master-key-v2'; // >= 16 chars

test('rotation: full roundtrip — every row re-encrypted, old master locked out, new master reads all', () => {
  withDbFile('roundtrip', () => {
    const { SecretsVault: SV, _resetVaultCache } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'old-master-0' });
    v.setSecret('main', 'a', 'alpha-value');
    v.setSecret('main', 'b', 'beta-value');
    v.setSecret('acme-corp', 'a', 'acme-alpha');

    // Raw ciphertexts before rotation
    const { db } = require('../src/gateway/db');
    const before = db.prepare('SELECT tenant, key, value_enc FROM tenant_secrets ORDER BY tenant, key').all();

    const r = v.rotateMasterKey(NEWKEY);
    assert.deepEqual(r, { ok: true, rotatedCount: 3 });

    // Ciphertexts all CHANGED (re-encrypted under the new master)
    const after = db.prepare('SELECT tenant, key, value_enc FROM tenant_secrets ORDER BY tenant, key').all();
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].tenant, before[i].tenant);
      assert.equal(after[i].key, before[i].key);
      assert.notEqual(after[i].value_enc, before[i].value_enc, `row ${after[i].tenant}/${after[i].key} must be re-encrypted`);
      assert.ok(!after[i].value_enc.includes('alpha-value'));
      assert.ok(!after[i].value_enc.includes('beta-value'));
      assert.ok(!after[i].value_enc.includes('acme-alpha'));
    }

    // New master reads everything back
    assert.equal(v.getSecret('main', 'a'), 'alpha-value');
    assert.equal(v.getSecret('main', 'b'), 'beta-value');
    assert.equal(v.getSecret('acme-corp', 'a'), 'acme-alpha');

    // The OLD master can no longer decrypt anything (fresh vault object on
    // the same db file with the old master → honest nulls).
    _resetVaultCache();
    const vOld = new SV({ enabled: true, master: 'old-master-0' });
    assert.equal(vOld.getSecret('main', 'a'), null);
    assert.equal(vOld.getSecret('main', 'b'), null);
    assert.equal(vOld.getSecret('acme-corp', 'a'), null);
    // Key lists still intact (keys are not encrypted)
    assert.deepEqual(vOld.listKeys('main'), ['a', 'b']);

    // env was adopted by the rotation
    assert.equal(process.env.TG_SECRETS_MASTER_KEY, NEWKEY);
    assert.equal(v.master, NEWKEY);
  });
});

test('rotation: post-rotation get/set works with the new key; another rotate also works', () => {
  withDbFile('postrotate', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'first-master' });
    v.setSecret('main', 'k', 'v1');
    assert.deepEqual(v.rotateMasterKey('second-master-key'), { ok: true, rotatedCount: 1 });
    assert.equal(v.getSecret('main', 'k'), 'v1');
    assert.equal(v.setSecret('main', 'k2', 'v2'), true); // stored under second master
    assert.equal(v.getSecret('main', 'k2'), 'v2');

    // second rotation re-encrypts BOTH rows (one written pre-rotation, one after)
    assert.deepEqual(v.rotateMasterKey('third-master-key-here'), { ok: true, rotatedCount: 2 });
    assert.equal(v.getSecret('main', 'k'), 'v1');
    assert.equal(v.getSecret('main', 'k2'), 'v2');
    assert.equal(process.env.TG_SECRETS_MASTER_KEY, 'third-master-key-here');
  });
});

test('rotation: abort-on-single-failure — corrupt row rolls back EVERYTHING, old master still works', () => {
  withDbFile('abort', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'abort-master-long' });
    v.setSecret('main', 'good1', 'value-one');
    v.setSecret('main', 'good2', 'value-two');
    v.setSecret('doomed-tenant', 'corrupt', 'will-be-corrupted');

    // Inject a corrupt row (tampered ciphertext — not decryptable by anyone)
    const { db } = require('../src/gateway/db');
    db.prepare("UPDATE tenant_secrets SET value_enc = 'not.a.real.ciphertext' WHERE tenant = 'doomed-tenant' AND key = 'corrupt'").run();

    const snapshot = db.prepare('SELECT tenant, key, value_enc, updated_at FROM tenant_secrets ORDER BY tenant, key').all();
    const t0 = Date.now() + 100000; // far-future stamp: any write would show
    const r = v.rotateMasterKey(NEWKEY);

    assert.equal(r.ok, false);
    assert.equal(r.rotatedCount, 0, 'rotation must be all-or-nothing');
    assert.equal(r.failedKeys.length, 1);
    assert.deepEqual(r.failedKeys[0], { tenant: 'doomed-tenant', key: 'corrupt', error: 'decrypt_failed_under_current_master' });

    // NOTHING was written: byte-identical rows (including updated_at)
    const after = db.prepare('SELECT tenant, key, value_enc, updated_at FROM tenant_secrets ORDER BY tenant, key').all();
    assert.deepEqual(after, snapshot);

    // The old master still decrypts the good rows — vault usable, no lockout
    assert.equal(v.getSecret('main', 'good1'), 'value-one');
    assert.equal(v.getSecret('main', 'good2'), 'value-two');
    assert.equal(v.master, 'abort-master-long', 'master NOT adopted on failure');
    assert.notEqual(process.env.TG_SECRETS_MASTER_KEY, NEWKEY, 'env NOT moved to the new key on failure');

    // Heal the corrupt row (re-set under the current master), retry → succeeds
    v.setSecret('doomed-tenant', 'corrupt', 'healed');
    const r2 = v.rotateMasterKey(NEWKEY);
    assert.deepEqual(r2, { ok: true, rotatedCount: 3 });
    assert.equal(v.getSecret('doomed-tenant', 'corrupt'), 'healed');
  });
});

test('rotation: same-key refused (throws, nothing changes)', () => {
  withDbFile('samekey', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'the-same-master-key' });
    v.setSecret('main', 'k', 'v');
    const before = require('../src/gateway/db').db
      .prepare('SELECT value_enc FROM tenant_secrets').all();
    assert.throws(() => v.rotateMasterKey('the-same-master-key'), /equals current/);
    const after = require('../src/gateway/db').db
      .prepare('SELECT value_enc FROM tenant_secrets').all();
    assert.deepEqual(after, before);
    assert.equal(v.getSecret('main', 'k'), 'v');
    // env untouched by the refused rotation (withDbFile had it unset)
    assert.ok(process.env.TG_SECRETS_MASTER_KEY === undefined);
  });
});

test('rotation: weak-key refused (missing, short, non-string)', () => {
  withDbFile('weakkey', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV({ enabled: true, master: 'current-master-key' });
    v.setSecret('main', 'k', 'v');
    assert.throws(() => v.rotateMasterKey('short'), /too short/);           // < 16 chars
    assert.throws(() => v.rotateMasterKey(''), /too short/);
    assert.throws(() => v.rotateMasterKey(undefined), /too short/);
    assert.throws(() => v.rotateMasterKey(12345678901234567), /too short/); // non-string
    assert.equal(v.getSecret('main', 'k'), 'v');
    assert.equal(v.master, 'current-master-key');
  });
});

test('rotation: env-off vault is inert — rotateMasterKey throws vault_disabled', () => {
  withDbFile('envoff', () => {
    const { SecretsVault: SV } = freshModules([VAULT]);
    const v = new SV(); // TG_SECRETS_VAULT unset in withDbFile
    assert.equal(v.enabled, false);
    assert.throws(() => v.rotateMasterKey(NEWKEY), /vault_disabled/);

    const vm = new SV({ enabled: true, master: null }); // enabled but no master
    assert.throws(() => vm.rotateMasterKey(NEWKEY), /vault_master_key_missing/);
  });
});

// ── operator mount tests ────────────────────────────────────────────────────

const OP = 'tok-j2-op';
const WK = 'tok-j2-wk';

function makeGw() {
  process.env.TG_SECRETS_VAULT = '1';
  process.env.TG_SECRETS_MASTER_KEY = 'mount-master-key';
  for (const m of Object.keys(require.cache)) {
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

test('mount: operator POST rotates → {ok, rotatedCount}; audited; new key usable; old key dead', async () => {
  await withDbFile('mount-ok', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // seed two secrets through the normal PUT route
      const put1 = await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/s1', OP, { value: 'secret-ONE' });
      const put2 = await fetch2(s.port, 'PUT', '/v2/tenants/acme-corp/secrets/s2', OP, { value: 'secret-TWO' });
      assert.equal(put1.status, 200);
      assert.equal(put2.status, 200);

      const before = require('../src/gateway/db').db
        .prepare('SELECT tenant, key, value_enc FROM tenant_secrets ORDER BY tenant, key').all();

      const r = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'brand-new-master' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true, rotatedCount: 2 });
      // new master never echoed
      assert.ok(!r.text.includes('brand-new-master'));
      assert.ok(!r.text.includes('mount-master-key'));

      // rows were re-encrypted
      const after = require('../src/gateway/db').db
        .prepare('SELECT tenant, key, value_enc FROM tenant_secrets ORDER BY tenant, key').all();
      for (let i = 0; i < before.length; i++) {
        assert.notEqual(after[i].value_enc, before[i].value_enc);
      }

      // vault adopted the new master: get works via internal path, values intact
      const vault = require('../src/gateway/secrets-vault').getSecretsVault(gw);
      assert.equal(vault.master, 'brand-new-master');
      assert.equal(vault.getSecret('main', 's1'), 'secret-ONE');
      assert.equal(vault.getSecret('acme-corp', 's2'), 'secret-TWO');

      // a value set AFTER rotation decrypts under the new master
      const put3 = await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/s3', OP, { value: 'secret-THREE' });
      assert.equal(put3.status, 200);
      assert.equal(vault.getSecret('main', 's3'), 'secret-THREE');

      // audit rows
      const types = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(types.includes('secret_master_rotated'));
      const row = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'secret_master_rotated');
      assert.deepEqual(Object.keys(row).sort(), ['by', 'rotatedCount', 'type']);
      assert.equal(row.rotatedCount, 2);
    } finally { await s.close(); }
  });
});

test('mount: worker 403 + audited secret_master_rotate_failed {bot}; anonymous 401', async () => {
  await withDbFile('mount-auth', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const denied = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', WK, { newMasterKey: 'worker-attempt-key' });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');
      const anon = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', null, { newMasterKey: 'anon-attempt-key' });
      assert.equal(anon.status, 401);
      const rows = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'secret_master_rotate_failed');
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['bot', 'type']);
      assert.equal(rows[0].bot, 'forge');
      // vault master untouched
      const vault = require('../src/gateway/secrets-vault').getSecretsVault(gw);
      assert.equal(vault.master, 'mount-master-key');
    } finally { await s.close(); }
  });
});

test('mount: guards — vault off → 404, weak_key → 400, same_key → 400', async () => {
  await withDbFile('mount-guards', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const weak = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'tiny' });
      assert.equal(weak.status, 400);
      assert.equal(weak.json.error, 'weak_key');
      const missing = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, {});
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error, 'weak_key');
      const same = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'mount-master-key' });
      assert.equal(same.status, 400);
      assert.equal(same.json.error, 'same_key');
      const types = gw.chain.entries.map((e) => e.payload.type);
      assert.ok(!types.includes('secret_master_rotated'), 'refusals are not successes');
    } finally { await s.close(); }

    // env off → 404 vault_disabled (feature off = not there)
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
    gw2.mounts.push(require('../src/gateway/mounts/119-secrets-rotate'));
    const s2 = await serve(gw2);
    try {
      const off = await fetch2(s2.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'off-but-valid-key' });
      assert.equal(off.status, 404);
      assert.equal(off.json.error, 'vault_disabled');
    } finally { await s2.close(); }
  });
});

test('mount: corrupt row → 409 rotate_failed with failedKeys; audited; rows byte-identical after', async () => {
  await withDbFile('mount-abort', async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      await fetch2(s.port, 'PUT', '/v2/tenants/main/secrets/good', OP, { value: 'kept-value' });
      const db = require('../src/gateway/db').db;
      db.prepare("UPDATE tenant_secrets SET value_enc = 'x.y.z' WHERE key = 'good'").run();

      const snapshot = db.prepare('SELECT tenant, key, value_enc, updated_at FROM tenant_secrets').all();
      const r = await fetch2(s.port, 'POST', '/v2/secrets/rotate-master', OP, { newMasterKey: 'never-adopted-key' });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'rotate_failed');
      assert.equal(r.json.failedCount, 1);
      assert.deepEqual(r.json.failedKeys, [{ tenant: 'main', key: 'good', error: 'decrypt_failed_under_current_master' }]);
      assert.ok(!r.text.includes('never-adopted-key'), 'new master never echoed on failure either');

      const after = db.prepare('SELECT tenant, key, value_enc, updated_at FROM tenant_secrets').all();
      assert.deepEqual(after, snapshot, 'aborted rotation must write NOTHING');

      const row = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'secret_master_rotate_failed');
      assert.deepEqual(Object.keys(row).sort(), ['by', 'errors', 'failedCount', 'type']);
      assert.equal(row.failedCount, 1);
      const vault = require('../src/gateway/secrets-vault').getSecretsVault(gw);
      assert.equal(vault.master, 'mount-master-key', 'master not adopted on aborted rotation');
    } finally { await s.close(); }
  });
});
