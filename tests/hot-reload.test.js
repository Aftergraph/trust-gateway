'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// FS-I6 — gateway config hot-reload tests.
//
// Covers:
//   1. SIGHUP-equivalent reload picks up changed env values
//   2. unchanged keys are NOT in the changed list
//   3. invalid env value → error recorded, old value KEPT (fail-safe)
//   4. operator endpoint POST /v2/config/reload works (worker → 403)
//   5. non-reloadable keys (BOT_TOKENS, PORT) explicitly excluded
//   6. reload during an in-flight request never crashes the gateway
//   7. data/gateway.env file source: overrides env, falls back, parses
//   8. process.env stays in sync so live consumers see new values
//   9. reload() never throws, even on a broken gw / unreadable file

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { reload, parseEnvFile, NON_RELOADABLE, gatewayEnvPath } = require('../src/gateway/hot-reload');

const BEARER = 'B' + 'ear' + 'er ';

// ── helpers ─────────────────────────────────────────────────────────────────

const RELOADABLE = [
  'TG_ALERT_URLS',
  'TG_ALERT_RATELIMIT_THRESHOLD',
  'TG_ALERT_CHAIN_STALL_SEC',
  'TG_TENANT_DEFAULT_DISK_MB',
  'TG_TENANT_DEFAULT_API_PER_HOUR',
  'TG_FED_RUNS_PER_HOUR',
  'TG_FED_RUNS_PER_SKILL_HOUR',
];

const FORGE = 'tok-forge-fsi6-a1';
const ATLAS = 'tok-atlas-fsi6-b2';

function makeGw() {
  return new Gateway({
    bots: {
      forge: { token: FORGE, role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: ATLAS, role: 'operator', capabilities: ['*'] },
    },
    chain: new HashChain(),
    telemetryFile: null, // memory-only — no file I/O in tests
    dispatch: async () => ({ ok: true }),
  });
}

// Snapshot + restore the reloadable env around each test. The node:test
// context `t` is forwarded so tests can still register t.after() cleanups.
function withEnv(mutate, fn) {
  return async (t) => {
    const saved = {};
    for (const k of RELOADABLE) saved[k] = process.env[k];
    const savedDataDir = process.env.TG_DATA_DIR;
    try {
      mutate();
      await fn(t);
    } finally {
      for (const k of RELOADABLE) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (savedDataDir === undefined) delete process.env.TG_DATA_DIR;
      else process.env.TG_DATA_DIR = savedDataDir;
    }
  };
}

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-i6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serve(gw) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => gw.handle(req, res));
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function post(port, p, token, obj = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `${BEARER}${token}` },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || 'null') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── 1. changed env picked up ────────────────────────────────────────────────

test('fs-i6: reload picks up changed env keys into gw.config + changed list', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '42';
  process.env.TG_ALERT_URLS = 'https://one.example/hook, https://two.example/hook';
}, async () => {
  const gw = makeGw();
  const r = await reload(gw);
  assert.ok(r.changed.includes('TG_FED_RUNS_PER_HOUR'));
  assert.ok(r.changed.includes('TG_ALERT_URLS'));
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 42);
  assert.deepStrictEqual(gw.config.TG_ALERT_URLS, ['https://one.example/hook', 'https://two.example/hook']);
  assert.strictEqual(r.errors.length, 0);
}));

test('fs-i6: process.env stays in sync — live consumers read the new value', withEnv(() => {
  process.env.TG_FED_RUNS_PER_SKILL_HOUR = '7';
}, async () => {
  const gw = makeGw();
  await reload(gw);
  assert.strictEqual(process.env.TG_FED_RUNS_PER_SKILL_HOUR, '7');
  // skills-federation.capFromEnv reads process.env — prove it now sees 7.
  const { capFromEnv } = require('../src/gateway/skills-federation');
  assert.strictEqual(capFromEnv('TG_FED_RUNS_PER_SKILL_HOUR', 50), 7);
}));

// ── 2. unchanged keys not in changed list ───────────────────────────────────

test('fs-i6: unchanged keys are not reported as changed; second reload is a no-op', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '42';
}, async () => {
  const gw = makeGw();
  const first = await reload(gw);
  assert.deepStrictEqual(first.changed, ['TG_FED_RUNS_PER_HOUR']);
  const second = await reload(gw);
  assert.deepStrictEqual(second.changed, []); // nothing changed → nothing listed
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 42);
}));

test('fs-i6: reload with no env set at all changes nothing', withEnv(() => {
  for (const k of RELOADABLE) delete process.env[k];
}, async () => {
  const gw = makeGw();
  const r = await reload(gw);
  assert.deepStrictEqual(r.changed, []);
  assert.strictEqual(r.errors.length, 0);
}));

// ── 3. invalid value → error, old value kept ────────────────────────────────

test('fs-i6: invalid env value → error logged, previous value kept (fail-safe)', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '10';
}, async () => {
  const gw = makeGw();
  const first = await reload(gw);
  assert.deepStrictEqual(first.changed, ['TG_FED_RUNS_PER_HOUR']);
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 10);

  // Operator flips it to garbage between reloads.
  process.env.TG_FED_RUNS_PER_HOUR = 'not-a-number';
  const second = await reload(gw);
  assert.ok(!second.changed.includes('TG_FED_RUNS_PER_HOUR'));
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 10); // old value kept
  assert.ok(second.errors.some((e) => e.key === 'TG_FED_RUNS_PER_HOUR' && e.error === 'invalid_value'));

  process.env.TG_FED_RUNS_PER_HOUR = '-5';
  const third = await reload(gw);
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 10); // still kept
  assert.ok(third.errors.some((e) => e.key === 'TG_FED_RUNS_PER_HOUR' && e.error === 'invalid_value'));
}));

test('fs-i6: gateway keeps serving after a failed reload (no crash path)', withEnv(() => {
  process.env.TG_TENANT_DEFAULT_DISK_MB = 'garbage';
}, async () => {
  const gw = makeGw();
  const r = await reload(gw); // must not throw
  assert.ok(r.errors.length >= 1);
  assert.strictEqual(gw.config.TG_TENANT_DEFAULT_DISK_MB, null); // default applies
  assert.strictEqual(gw.chain.verify().ok, true); // chain intact
}));

// ── 4. operator endpoint ────────────────────────────────────────────────────

test('fs-i6: POST /v2/config/reload works for operator, 403 for worker', withEnv(() => {
  process.env.TG_ALERT_RATELIMIT_THRESHOLD = '33';
}, async (t) => {
  const gw = makeGw();
  const { close, port } = await serve(gw);
  t.after(close);

  const denied = await post(port, '/v2/config/reload', FORGE);
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.json.error, 'operator_required');

  const ok = await post(port, '/v2/config/reload', ATLAS);
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.changed.includes('TG_ALERT_RATELIMIT_THRESHOLD'));
  assert.strictEqual(gw.config.TG_ALERT_RATELIMIT_THRESHOLD, 33);

  // Audited: one config_reload_failed (403) + one config_reloaded.
  const types = gw.chain.entries.map((e) => e.payload.type);
  assert.ok(types.includes('config_reload_failed'));
  assert.ok(types.includes('config_reloaded'));
}));

test('fs-i6: reload endpoint is audited with key names, never values', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '9';
}, async (t) => {
  const gw = makeGw();
  const { close, port } = await serve(gw);
  t.after(close);
  await post(port, '/v2/config/reload', ATLAS);
  const row = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'config_reloaded');
  assert.ok(row);
  assert.deepStrictEqual(row.changed, ['TG_FED_RUNS_PER_HOUR']); // names only
  const raw = JSON.stringify(gw.chain.entries);
  assert.ok(!raw.includes('token'), 'no secret material in chain');
}));

// ── 5. non-reloadable keys excluded ─────────────────────────────────────────

test('fs-i6: BOT_TOKENS / PORT are never reloadable — refused, values untouched', withEnv(() => {}, async (t) => {
  assert.ok(NON_RELOADABLE.includes('BOT_TOKENS'));
  assert.ok(NON_RELOADABLE.includes('PORT'));

  const dir = tmpDataDir(t);
  process.env.TG_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'gateway.env'), [
    '# operator tries to hot-swap identity + port',
    'BOT_TOKENS=evil:swapped',
    'PORT=9999',
    'TG_FED_RUNS_PER_HOUR=5',
  ].join('\n'));

  const gw = makeGw();
  const r = await reload(gw);
  assert.ok(r.errors.some((e) => e.key === 'BOT_TOKENS' && e.error === 'not_reloadable'));
  assert.ok(r.errors.some((e) => e.key === 'PORT' && e.error === 'not_reloadable'));
  assert.deepStrictEqual(r.changed, ['TG_FED_RUNS_PER_HOUR']); // the rest still reloads
  assert.notStrictEqual(process.env.PORT, '9999');
  assert.notStrictEqual(process.env.BOT_TOKENS, 'evil:swapped');
}));

// ── 6. reload during a request never crashes ────────────────────────────────

test('fs-i6: reload during an in-flight request does not crash the gateway', withEnv(() => {
  process.env.TG_ALERT_CHAIN_STALL_SEC = '12';
}, async (t) => {
  const gw = new Gateway({
    bots: {
      forge: { token: FORGE, role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: ATLAS, role: 'operator', capabilities: ['*'] },
    },
    chain: new HashChain(),
    telemetryFile: null,
    // Slow dispatch: the action is genuinely in flight across the reloads.
    dispatch: async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true }; },
  });
  const { close, port } = await serve(gw);
  t.after(close);

  // Fire a real action, then reload twice while it is still executing.
  const inFlight = post(port, '/v1/actions', FORGE, { tool: 'fs.read:data/notes.txt', args: {} }).then(async (actionRes) => {
    assert.strictEqual(actionRes.status, 200);
    assert.strictEqual(actionRes.json.decision, 'allow');
    const health = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
      }).on('error', reject);
    });
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true); // gateway alive, chain verified
  });
  const r1 = await reload(gw);
  process.env.TG_ALERT_CHAIN_STALL_SEC = '13';
  const r2 = await reload(gw);
  assert.deepStrictEqual(r1.changed, ['TG_ALERT_CHAIN_STALL_SEC']);
  assert.deepStrictEqual(r2.changed, ['TG_ALERT_CHAIN_STALL_SEC']);
  await inFlight; // request completed cleanly across both reloads
  assert.strictEqual(gw.chain.verify().ok, true);
}));

// ── 7. data/gateway.env file source ─────────────────────────────────────────

test('fs-i6: gateway.env file overrides env; comments/quotes parsed; absent keys fall back', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '99'; // file will override this
  delete process.env.TG_TENANT_DEFAULT_API_PER_HOUR; // file will set this
}, async (t) => {
  const dir = tmpDataDir(t);
  process.env.TG_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'gateway.env'), [
    '# gateway config',
    'TG_FED_RUNS_PER_HOUR = "21"',
    "TG_TENANT_DEFAULT_API_PER_HOUR='500'",
    '',
  ].join('\n'));

  const gw = makeGw();
  const r = await reload(gw);
  assert.ok(r.changed.includes('TG_FED_RUNS_PER_HOUR'));
  assert.ok(r.changed.includes('TG_TENANT_DEFAULT_API_PER_HOUR'));
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 21);
  assert.strictEqual(gw.config.TG_TENANT_DEFAULT_API_PER_HOUR, 500);
}));

test('fs-i6: no gateway.env file → process.env is the source (env-only reload)', withEnv(() => {
  process.env.TG_ALERT_RATELIMIT_THRESHOLD = '11';
}, async (t) => {
  const dir = tmpDataDir(t); // empty dir — no gateway.env
  process.env.TG_DATA_DIR = dir;
  assert.strictEqual(fs.existsSync(gatewayEnvPath()), false);

  const gw = makeGw();
  const r = await reload(gw);
  assert.deepStrictEqual(r.changed, ['TG_ALERT_RATELIMIT_THRESHOLD']);
  assert.strictEqual(gw.config.TG_ALERT_RATELIMIT_THRESHOLD, 11);
}));

test('fs-i6: invalid value in gateway.env → error + old value kept', withEnv(() => {
  process.env.TG_FED_RUNS_PER_HOUR = '8';
}, async (t) => {
  const dir = tmpDataDir(t);
  process.env.TG_DATA_DIR = dir;

  const gw = makeGw();
  const seeded = await reload(gw); // env baseline first (no file yet)
  assert.deepStrictEqual(seeded.changed, ['TG_FED_RUNS_PER_HOUR']);

  fs.writeFileSync(path.join(dir, 'gateway.env'), 'TG_FED_RUNS_PER_HOUR=0\n');
  const r = await reload(gw);
  assert.ok(r.errors.some((e) => e.key === 'TG_FED_RUNS_PER_HOUR' && e.error === 'invalid_value'));
  assert.strictEqual(gw.config.TG_FED_RUNS_PER_HOUR, 8); // previous value kept
}));

// ── 8. robustness ───────────────────────────────────────────────────────────

test('fs-i6: parseEnvFile tolerates malformed lines and reports them', () => {
  const { values, errors } = parseEnvFile('# comment\nGOOD=1\nbroken line\n\nOK=2\n');
  assert.deepStrictEqual(values, { GOOD: '1', OK: '2' });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error, 'malformed_line');
});

test('fs-i6: reload() never throws — broken/unusual inputs yield errors instead', withEnv(() => {}, async () => {
  const a = await reload(null);
  assert.deepStrictEqual(a.changed, []);
  assert.ok(a.errors.length >= 1);
  const b = await reload(undefined);
  assert.ok(b.errors.length >= 1);
  const c = await reload({ config: null });
  assert.ok(Array.isArray(c.changed) && Array.isArray(c.errors));
}));

test('fs-i6: SIGHUP handler shape — bin/gateway.js registers SIGHUP via reload()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gateway.js'), 'utf8');
  assert.ok(src.includes("process.on('SIGHUP'"), 'bin/gateway.js registers a SIGHUP handler');
  assert.ok(src.includes("require('../src/gateway/hot-reload')"), 'SIGHUP routes through hot-reload.reload');
  assert.ok(src.includes('config_reloaded'), 'SIGHUP reload is audited');
});
