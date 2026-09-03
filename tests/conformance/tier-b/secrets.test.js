'use strict';
// FS-F2 conformance tier-B — SECRETS deep battery.
//
// Write-only secret hygiene, end to end, on a REAL spawned gateway
// (tests/fs-helpers.js): a secret is written through the write-only plugin
// surface (PUT /v2/plugins/:id/secrets/:n) and then a GREP CHAIN hunts the
// raw value across every place it must never appear — every HTTP response
// body captured during the battery, the full audit chain over HTTP, the
// audit JSONL file on disk, the gateway's own stdout/stderr log — with ZERO
// hits. The only echo allowed is {name, configured, length}.
//
// The value itself is stored ONCE, write-only, in the plugins state file
// (mode 0600, no read endpoint) — that storage is asserted too, not greped.
//
// Zero deps beyond node: builtins.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnGateway, api, TOKENS } = require('../../fs-helpers');

const TESTS = [];
function t(name, fn) { TESTS.push({ name, fn }); }

const SECRET = 'tierb-hygiene-' + Date.now() + '-Zq9w8xK2';
const MODULE_ID = 'demo-echo'; // ships with the repo; declares secret API_KEY
const SECRET_NAME = 'API_KEY';

// Every captured HTTP body and every byte we will grep for the raw secret.
const RESPONSES = [];

async function capture(base, method, p, opts) {
  const r = await api(base, method, p, opts);
  RESPONSES.push(r.text);
  return r;
}

let gw = null;
let stateFile = null;

t('setup: operator installs the module; worker writes are refused', async () => {
  const denied = await capture(gw.base, 'POST', '/v2/plugins', { token: TOKENS.forge, body: { id: MODULE_ID } });
  assert.equal(denied.status, 403, 'non-operator install → 403');
  const inst = await capture(gw.base, 'POST', '/v2/plugins', { token: TOKENS.atlas, body: { id: MODULE_ID } });
  assert.equal(inst.status, 201, `install demo-echo → 201, got ${inst.status}: ${inst.text.slice(0, 120)}`);
});

t('echo is length-only: PUT response carries {name, configured, length} and no value', async () => {
  const put = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/${SECRET_NAME}`,
    { token: TOKENS.atlas, body: { value: SECRET } });
  assert.equal(put.status, 200, `PUT secret → 200, got ${put.status} ${put.text.slice(0, 120)}`);
  assert.deepEqual(put.json.secret, { name: SECRET_NAME, configured: true, length: SECRET.length },
    'echo is exactly name + configured + length');
  assert.ok(!put.text.includes(SECRET), 'raw secret echoed back');
});

t('input hygiene: undeclared name and empty value fail closed', async () => {
  const undeclared = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/NOT_DECLARED`,
    { token: TOKENS.atlas, body: { value: 'whatever' } });
  assert.equal(undeclared.status, 400);
  assert.equal(undeclared.json.error, 'secret_undeclared');
  const empty = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/${SECRET_NAME}`,
    { token: TOKENS.atlas, body: { value: '' } });
  assert.equal(empty.status, 400);
  const badName = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/9bad-name`,
    { token: TOKENS.atlas, body: { value: 'whatever' } });
  assert.equal(badName.status, 400);
});

t('no read endpoint exists: module view carries only {name, required, configured, length}', async () => {
  const view = await capture(gw.base, 'GET', `/v2/plugins/${MODULE_ID}`, { token: TOKENS.atlas });
  assert.equal(view.status, 200);
  const sec = view.json.module.secrets.find((s) => s.name === SECRET_NAME);
  assert.ok(sec, 'declared secret shown in the view');
  assert.deepEqual(Object.keys(sec).sort(), ['configured', 'length', 'name', 'required'],
    'view projection is metadata only — no value field');
  assert.equal(sec.configured, true);
  assert.equal(sec.length, SECRET.length, 'length echo is correct');
  const list = await capture(gw.base, 'GET', '/v2/plugins', { token: TOKENS.atlas });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.json).includes(SECRET), 'module list leaks the secret');
});

t('audit: secret_configured rows carry length only; chain sealed', async () => {
  const audit = await capture(gw.base, 'GET', '/v1/audit', { token: TOKENS.atlas });
  assert.equal(audit.status, 200);
  const rows = audit.json.entries.filter((e) => e.payload.type === 'secret_configured');
  assert.ok(rows.length >= 1, 'secret_configured audited');
  assert.deepEqual(Object.keys(rows[0].payload).sort(), ['id', 'length', 'name', 'type'],
    'audit row is id/name/length ONLY — no value field');
  const verify = await capture(gw.base, 'GET', '/v1/audit/verify', { token: TOKENS.atlas });
  assert.equal(verify.json.ok, true);
});

t('grep chain: raw secret has ZERO hits in audit file, responses, and gateway log', async () => {
  // 1. the audit JSONL file on disk
  const auditFile = path.join(gw.tmp, 'audit.jsonl');
  assert.ok(fs.existsSync(auditFile), 'audit file exists');
  const auditBytes = fs.readFileSync(auditFile, 'utf8');
  assert.ok(auditBytes.includes('secret_configured'), 'audit file really holds the secret_configured rows');
  assert.ok(!auditBytes.includes(SECRET), 'AUDIT FILE contains the raw secret');
  // 2. every HTTP response body captured during this battery
  const leak = RESPONSES.filter((r) => r.includes(SECRET));
  assert.equal(leak.length, 0, `secret appeared in ${leak.length} response(s)`);
  // 3. the gateway process log (stdout+stderr)
  assert.ok(!gw.proc.log.includes(SECRET), 'gateway log contains the raw secret');
});

t('storage: value kept write-only in the 0600 state file — never in any projection', async () => {
  const stateFileLocal = path.join(process.env.TG_PLUGINS_DATA_DIR, 'plugins.json');
  stateFile = stateFileLocal;
  const raw = fs.readFileSync(stateFileLocal, 'utf8');
  assert.ok(raw.includes(SECRET), 'the write-only store holds the value (it must be retrievable)');
  const mode = fs.statSync(stateFileLocal).mode & 0o777;
  assert.equal(mode, 0o600, `state file mode 0600, got ${mode.toString(8)}`);
});

t('update + delete: re-PUT changes the stored value; DELETE removes it', async () => {
  const v2 = SECRET + '-rotated';
  const put2 = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/${SECRET_NAME}`,
    { token: TOKENS.atlas, body: { value: v2 } });
  assert.equal(put2.status, 200);
  assert.equal(put2.json.secret.length, v2.length, 'echo tracks the NEW length');
  const del = await capture(gw.base, 'DELETE', `/v2/plugins/${MODULE_ID}/secrets/${SECRET_NAME}`,
    { token: TOKENS.atlas });
  assert.equal(del.status, 200);
  // after delete the write-only store no longer holds it
  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.ok(!raw.includes(SECRET) && !raw.includes(v2), 'deleted secret value removed from storage');
  // worker cannot write secrets either (operator_required on the write mount)
  const wk = await capture(gw.base, 'PUT', `/v2/plugins/${MODULE_ID}/secrets/${SECRET_NAME}`,
    { token: TOKENS.forge, body: { value: SECRET } });
  assert.equal(wk.status, 403);
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  let fails = 0;
  try {
    // Plugins state MUST land in the gateway's tmp jail, never the repo data
    // dir — set BEFORE the spawn so the child inherits it (env is captured at
    // spawn time), and the hub binds its state file there at first use.
    process.env.TG_PLUGINS_DATA_DIR = path.join(fs.mkdtempSync(
      path.join(os.tmpdir(), 'fsf2-plugins-')), 'plugins-data');
    gw = await spawnGateway({});
  } catch (e) {
    console.error('SECRETS CRASH', e && e.message);
    process.exit(2);
  }
  if (gw) {
    for (const { name, fn } of TESTS) {
      try { await fn(); console.log('  ✔ ' + name); }
      catch (e) { fails++; console.log('  ✖ ' + name + '\n      → ' + (e && e.message)); }
    }
    await gw.close();
  }
  console.log(fails ? '\n✖ SECRETS ' + fails + ' failed' : '\n★ SECRETS PASS');
  process.exit(fails ? 1 : 0);
})();