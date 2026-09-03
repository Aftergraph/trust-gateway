'use strict';
// FS-G2 tests — operator observability snapshot.
//
// Covers: snapshot() shape (scalars only — no token material, no raw
// telemetry payloads beyond counts), operator-only mount (worker 403 +
// observability_denied audit), observability_read audit row, main-tenant
// byte-identical body (no tenant fields), uptime sanity, byType top-5
// bound, apikeys rate-limit counter, and the console client source
// assertion (agents-system.js renders the system-health row).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REPO = path.resolve(__dirname, '..');
const { snapshot } = require('../src/gateway/obsv');

function withDbFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-g2-'));
  const prevDb = process.env.TG_DB_FILE;
  const prevData = process.env.TG_DATA_DIR;
  const prevCwd = process.cwd();
  process.env.TG_DB_FILE = path.join(dir, 'gateway.db');
  process.env.TG_DATA_DIR = path.join(dir, 'data');
  process.chdir(dir);
  const done = () => {
    process.chdir(prevCwd);
    if (prevDb === undefined) delete process.env.TG_DB_FILE; else process.env.TG_DB_FILE = prevDb;
    if (prevData === undefined) delete process.env.TG_DATA_DIR; else process.env.TG_DATA_DIR = prevData;
  };
  return Promise.resolve().then(() => fn(dir)).finally(done);
}

// Fresh module graph per test: db.js is a process singleton.
function freshModules(extra = []) {
  const suffixes = ['/src/gateway/db.js', '/src/gateway/tenants.js', '/src/gateway/apikeys.js',
    '/src/gateway/obsv.js', '/src/gateway/mounts/114-observability.js',
    '/src/gateway/skills.js', '/src/gateway/events.js', ...extra];
  for (const m of Object.keys(require.cache)) {
    if (suffixes.some((s) => m.endsWith(s))) delete require.cache[m];
  }
}

const OP = 'tok-g2-op';
const WK = 'tok-g2-wk';

function makeGw() {
  freshModules();
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
  gw.mounts.push(require('../src/gateway/mounts/114-observability'));
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

function fetch(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── snapshot() shape: scalars only ──────────────────────────────────────

function assertScalarsOnly(node, where) {
  if (node === null || typeof node === 'string' || typeof node === 'number' ||
      typeof node === 'boolean') return;
  assert.equal(typeof node, 'object', where + ' must be an object or scalar');
  assert.ok(!Array.isArray(node), where + ' must not be an array');
  for (const [k, v] of Object.entries(node)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null ||
      (typeof v === 'object' && !Array.isArray(v)),
      where + '.' + k + ' must be a scalar or nested object');
    assertScalarsOnly(v, where + '.' + k);
  }
}

test('snapshot: one object, scalars only, expected top-level keys', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = snapshot(gw);
    assert.deepEqual(
      Object.keys(s).sort(),
      ['apikeys', 'approvals', 'backups', 'chain', 'events', 'generatedAt',
        'skills', 'telemetry', 'tenants', 'uptimeSec'].sort()
    );
    assertScalarsOnly(s, 'snapshot');
    // chain section
    assert.equal(s.chain.ok, true);
    assert.ok(Number.isInteger(s.chain.length) && s.chain.length >= 1);
    assert.match(s.chain.head, /^[0-9a-f]{64}$/);
    // telemetry section: empty ring
    assert.equal(s.telemetry.total, 0);
    assert.deepEqual(s.telemetry.byType, {});
    assert.equal(s.telemetry.lastAt, null);
    // approvals
    assert.equal(s.approvals.pendingCount, 0);
    // apikeys / tenants (fresh db → zero, main only)
    assert.equal(s.apikeys.active, 0);
    assert.equal(s.apikeys.rateLimitedLast1h, 0);
    assert.equal(s.tenants.count, 1); // 'main' auto-created
    assert.equal(s.tenants.disabled, 0);
    // FS-H3: honest zeros when no skills/backups/clients exist
    assert.deepEqual(s.skills, { total: 0, shared: 0, federated: 0 });
    assert.deepEqual(s.backups, { count: 0, latestAt: null, latestChainHead: null });
    assert.deepEqual(s.events, { hubClients: 0 });
    // uptime sane: between 0 and 1 day for a test process
    assert.ok(Number.isInteger(s.uptimeSec) && s.uptimeSec >= 0 && s.uptimeSec < 86400);
    assert.ok(!Number.isNaN(Date.parse(s.generatedAt)));
  });
});

test('snapshot: telemetry byType counts, top-5 bound, no raw payloads leak', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    // ring is rate-limited per type (250 ms) — use distinct types
    const types = ['palette_open', 'palette_command', 'palette_search',
      'panel_manifest_validate', 'capability_filter_hit', 'compose_engine_render',
      'migration_phase', 'four_oh2_handled'];
    let base = Date.now() - 10_000;
    for (const t of types) {
      gw.telemetry.record(t, { secretField: 'DO_NOT_LEAK', n: 1 }, );
      gw.telemetry.now = () => (base += 300); // defeat the per-type rate limit
    }
    const s = snapshot(gw);
    assert.equal(s.telemetry.total, types.length);
    const topKeys = Object.keys(s.telemetry.byType);
    assert.ok(topKeys.length <= 5, 'byType capped at top-5');
    for (const c of Object.values(s.telemetry.byType)) assert.equal(c, 1);
    assert.ok(typeof s.telemetry.lastAt === 'number');
    // no field values, only counts: the projection must not contain payload text
    const flat = JSON.stringify(s);
    assert.ok(!flat.includes('DO_NOT_LEAK'), 'raw telemetry field leaked into snapshot');
    assert.ok(!flat.includes('secretField'));
  });
});

test('snapshot: approvals pending + apikeys active/rate-limited counters', async () => {
  await withDbFile(async () => {
    const gw = makeGw(); // fresh module graph FIRST (db.js is a singleton)
    const { getApiKeyStore } = require('../src/gateway/apikeys');
    // a pending approval
    gw.approvals.request({ bot: { name: 'forge' }, tool: 'fs.write', args: {}, reason: 'test' });
    // an active key with a rate plan — drive it to the max inside one window
    const created = getApiKeyStore(gw).create({
      name: 'k', owner: 'atlas', scopes: ['audit.read'],
      rate: { windowMs: 60_000, max: 2 },
    });
    const store = getApiKeyStore(gw);
    store.verify(created.plaintext);
    store.verify(created.plaintext);
    store.verify(created.plaintext); // 3rd → rate_limited (count hit max)

    const s = snapshot(gw);
    assert.equal(s.approvals.pendingCount, 1);
    assert.equal(s.apikeys.active, 1);
    assert.equal(s.apikeys.rateLimitedLast1h, 1);
  });
});

test('snapshot: no secrets ever — bot tokens and key plaintext absent', async () => {
  await withDbFile(async () => {
    const gw = makeGw(); // fresh module graph FIRST (db.js is a singleton)
    const { getApiKeyStore } = require('../src/gateway/apikeys');
    const created = getApiKeyStore(gw).create({
      name: 'k', owner: 'atlas', scopes: ['audit.read'],
    });
    const s = JSON.stringify(snapshot(gw));
    assert.ok(!s.includes(OP), 'operator bearer token leaked');
    assert.ok(!s.includes(WK), 'worker bearer token leaked');
    assert.ok(!s.includes(created.plaintext), 'apikey plaintext leaked');
    assert.ok(!s.includes('key_hash'), 'hash column leaked');
  });
});

// ── FS-H3: observability depth (skills / backups / events) ──────────────

test('snapshot FS-H3: skills visibility counts from the skills store', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    // Isolate the skills store: DEFAULT_FILE resolves to the repo's
    // data/skills.json regardless of cwd, so point the gateway at a temp
    // file via the documented gw._skillsFile hook instead.
    gw._skillsFile = path.join(process.cwd(), 'data', 'skills-test.json');
    const { getSkillStore } = require('../src/gateway/skills');
    const store = getSkillStore(gw);
    const step = { tool: 'fs.read', argsTemplate: '' };
    const a = store.create({ name: 'alpha-skill', version: '1.0.0', steps: [step], createdBy: 'atlas' });
    const b = store.create({ name: 'beta-skill', version: '1.0.0', steps: [step], createdBy: 'atlas' });
    const c = store.create({ name: 'gamma-skill', version: '1.0.0', steps: [step], createdBy: 'atlas' });
    store.setVisibility(a.id, 'shared');
    store.setVisibility(b.id, 'shared');
    store.federate(c.id, 'main'); // visibility 'federated' (only via federate)

    const s = snapshot(gw);
    assert.deepEqual(s.skills, { total: 3, shared: 2, federated: 1 });

    // FS-G1 off-switch: a federated skill with the env unset degrades to
    // shared semantics — but the projection reports the STORED visibility.
    assert.equal(process.env.TG_SKILLS_FEDERATION, undefined);
    assert.equal(s.skills.federated, 1);
  });
});

test('snapshot FS-H3: backups scalars from data/backups manifests (newest first)', async () => {
  await withDbFile(async () => {
    const gw = makeGw(); // fresh module graph FIRST (db.js is a singleton)
    // seed one file so createBackup has something to copy
    const d = path.join(process.cwd(), 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'bots.json'), JSON.stringify({ bots: [] }));

    const backup = require('../src/gateway/backup');
    const head1 = 'a'.repeat(64);
    const head2 = 'b'.repeat(64);
    const t1 = '2026-09-03T10:00:00.000Z';
    const t2 = '2026-09-03T11:00:00.000Z';
    backup.withChainFacts(backup.createBackup({ now: () => t1 }), { head: { hash: head1 }, chainId: 'chain-1' });
    backup.withChainFacts(backup.createBackup({ now: () => t2 }), { head: { hash: head2 }, chainId: 'chain-1' });

    const s = snapshot(gw);
    assert.equal(s.backups.count, 2);
    assert.equal(s.backups.latestAt, t2); // NEWEST manifest wins
    assert.equal(s.backups.latestChainHead, head2);
    // scalars only — no per-file entries, no sizes/hashes from the manifest
    assert.ok(!JSON.stringify(s).includes('"files"'), 'manifest file entries leaked');
    assert.ok(!JSON.stringify(s).includes('sha256'), 'manifest hashes leaked');
  });
});

test('snapshot FS-H3: corrupt newest manifest falls through to the older one', async () => {
  await withDbFile(async () => {
    const gw = makeGw(); // fresh module graph FIRST (db.js is a singleton)
    const d = path.join(process.cwd(), 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'bots.json'), JSON.stringify({ bots: [] }));

    const backup = require('../src/gateway/backup');
    const t1 = '2026-09-03T10:00:00.000Z';
    const t2 = '2026-09-03T11:00:00.000Z';
    backup.createBackup({ now: () => t1 });
    const second = backup.createBackup({ now: () => t2 });
    // corrupt the NEWEST manifest — the section must fall through to t1
    fs.writeFileSync(path.join(second.dir, 'manifest.json'), '{not json');

    const s = snapshot(gw);
    assert.equal(s.backups.count, 2); // both dirs still count
    assert.equal(s.backups.latestAt, t1);
    assert.equal(s.backups.latestChainHead, null); // first backup never had chain facts
  });
});

test('snapshot FS-H3: events hubClients reflects live SSE connections', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s0 = snapshot(gw);
    assert.equal(s0.events.hubClients, 0); // honest zero, no hub yet

    // attach two fake SSE clients via the real hub
    const { getHub } = require('../src/gateway/events');
    const hub = getHub(gw);
    const fakeRes = () => {
      const listeners = {};
      return {
        writeHead: () => {},
        write: () => {},
        on: (ev, fn) => { listeners[ev] = fn; },
        emit: (ev) => { if (listeners[ev]) listeners[ev](); },
        writableEnded: false,
      };
    };
    const r1 = fakeRes();
    const r2 = fakeRes();
    hub.addClient(r1);
    hub.addClient(r2);
    assert.equal(snapshot(gw).events.hubClients, 2);
    r1.emit('close');
    assert.equal(snapshot(gw).events.hubClients, 1);
    r2.emit('close');
    assert.equal(snapshot(gw).events.hubClients, 0);
  });
});

test('snapshot FS-H3: backup cap — count never exceeds 10 listed manifests', async () => {
  await withDbFile(async () => {
    const gw = makeGw(); // fresh module graph FIRST (db.js is a singleton)
    const d = path.join(process.cwd(), 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'bots.json'), JSON.stringify({ bots: [] }));

    const backup = require('../src/gateway/backup');
    // 12 backups → FIFO prune keeps 10 on disk; the projection must agree
    for (let i = 0; i < 12; i++) {
      const ts = new Date(Date.parse('2026-09-03T10:00:00Z') + i * 1000).toISOString();
      backup.createBackup({ now: () => ts });
    }
    const s = snapshot(gw);
    assert.equal(s.backups.count, 10);
    assert.equal(s.backups.latestAt, '2026-09-03T10:00:11.000Z');
    assert.ok(s.backups.latestAt !== null && !Number.isNaN(Date.parse(s.backups.latestAt)));
  });
});

// ── HTTP mount ──────────────────────────────────────────────────────────

test('mount GET /v2/observability: operator 200 snapshot, worker 403, both audited', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      // worker → 403 + observability_denied
      const denied = await fetch(s.port, 'GET', '/v2/observability', WK);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, 'operator_required');
      // anonymous → 401 (bearer auth)
      const anon = await fetch(s.port, 'GET', '/v2/observability', null);
      assert.equal(anon.status, 401);

      // operator → 200 snapshot; recomputed per call (the audit chain
      // grows with every observability_read, so strip chain + clocks
      // and the rest must agree)
      const a = await fetch(s.port, 'GET', '/v2/observability', OP);
      assert.equal(a.status, 200);
      const body = a.json;
      assert.equal(typeof body, 'object');
      assertScalarsOnly(body, 'response');
      assert.equal(body.chain.ok, true);
      assert.ok(Number.isInteger(body.uptimeSec));
      const b = await fetch(s.port, 'GET', '/v2/observability', OP);
      assert.equal(b.status, 200);
      const strip = (o) => JSON.stringify({ ...o, chain: 0, uptimeSec: 0, generatedAt: '' });
      assert.equal(strip(a.json), strip(b.json));

      // audit rows: two observability_read (one per operator call), one
      // observability_denied (the worker 403 does not read)
      const types = gw.chain.entries.map((e) => e.payload.type);
      assert.equal(types.filter((t) => t === 'observability_read').length, 2);
      assert.equal(types.filter((t) => t === 'observability_denied').length, 1);
      const readEntry = gw.chain.entries.find((e) => e.payload.type === 'observability_read');
      assert.equal(readEntry.payload.by, 'atlas');
      const deniedEntry = gw.chain.entries.find((e) => e.payload.type === 'observability_denied');
      assert.equal(deniedEntry.payload.bot, 'forge');
      // audit payload carries no token material
      assert.ok(!JSON.stringify(gw.chain.entries).includes(OP));
    } finally { await s.close(); }
  });
});

test('mount GET /v2/observability: main tenant — body carries no tenant fields', async () => {
  await withDbFile(async () => {
    const gw = makeGw();
    const s = await serve(gw);
    try {
      const r = await fetch(s.port, 'GET', '/v2/observability', OP);
      assert.equal(r.status, 200);
      const flat = r.text;
      // byte-identical rule: no per-tenant rows, no tenant id list, no
      // X-Tenant echo — only the aggregate tenant counts.
      assert.ok(!flat.includes('"id"'), 'tenant row fields leaked');
      assert.ok(!flat.includes('"name"'), 'tenant names leaked');
      assert.ok(!flat.includes('tnt_'), 'tenant token prefix leaked');
      assert.ok(r.json.tenants.count >= 1); // aggregate scalars still present
    } finally { await s.close(); }
  });
});

// ── console client source assertion ─────────────────────────────────────

test('console: agents-system.js renders a system-health row from /v2/observability', () => {
  const js = fs.readFileSync(path.join(REPO, 'app', 'panels', 'agents-system.js'), 'utf8');
  assert.match(js, /\/v2\/observability/, 'panel must fetch the observability snapshot');
  assert.match(js, /System health/, 'panel must render the System health row');
  assert.match(js, /\.catch\(/, 'panel must swallow 403/fetch failures (row hidden)');
  // XSS policy: no innerHTML anywhere in the panel
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'panel must never assign innerHTML');
});
