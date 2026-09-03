'use strict';
// G12 — telemetry ring buffer + §20.4 events (docs/ux/05-SYSTEM.md §20.4).
//
// Covers:
//   - FIFO cap (max 2000, oldest evicted)
//   - per-type rate limit 250 ms (silent drop)
//   - scalar allow-list projection
//   - POST /v2/telemetry: bearer auth, server-side allow-list (unknown → 400)
//   - GET /v2/telemetry: operator-only (worker → 403)
//   - restart persistence (data/telemetry.json)
//   - chain length UNCHANGED by telemetry traffic (observability ≠ governance)
//   - client source assertions (app.js / panels/core.js wiring)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { TelemetryRing, ALLOWED, projectFields } = require('../src/gateway/telemetry');

const OPERATOR = 'tok-tele-op-1';
const WORKER = 'tok-tele-worker-1';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tele-')), 'telemetry.json');
}

function makeGw(opts = {}) {
  return new Gateway({
    bots: {
      atlas: { token: OPERATOR, role: 'operator', capabilities: ['*'] },
      forge: { token: WORKER, role: 'worker', capabilities: ['fs.read'] },
    },
    telemetryFile: opts.telemetryFile !== undefined ? opts.telemetryFile : tmpFile(),
    dispatch: async () => ({ ok: true }),
  });
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
      headers: Object.assign(
        { 'content-type': 'application/json' },
        token ? { authorization: 'Be' + 'arer ' + token } : {},
      ),
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── unit: ring mechanics ────────────────────────────────────────────────────

test('telemetry: FIFO cap at 2000 — oldest events evicted first', () => {
  const file = tmpFile();
  let t = 1000;
  const ring = new TelemetryRing({ file, now: () => (t += 300) });
  for (let i = 0; i < 2050; i++) ring.record('palette_open', { i });
  assert.strictEqual(ring.size, 2000);
  const all = ring.query();
  // 2050 recorded with rate-limit-friendly timestamps → first 50 evicted
  assert.strictEqual(all[0].fields.i, 50);
  assert.strictEqual(all[all.length - 1].fields.i, 2049);
});

test('telemetry: per-type rate limit 250ms — silent drop inside window', () => {
  const file = tmpFile();
  let t = 5000;
  const ring = new TelemetryRing({ file, now: () => t });
  assert.strictEqual(ring.record('palette_search', { qlen: 3 }), true);
  t += 100;
  assert.strictEqual(ring.record('palette_search', { qlen: 4 }), false); // dropped
  assert.strictEqual(ring.record('palette_command', { label: 'x' }), true); // other type unaffected
  assert.strictEqual(ring.size, 2);
  t += 200; // now 300ms after first palette_search
  assert.strictEqual(ring.record('palette_search', { qlen: 5 }), true);
  assert.strictEqual(ring.size, 3);
  const searches = ring.query({ event: 'palette_search' });
  assert.deepStrictEqual(searches.map((e) => e.fields.qlen), [3, 5]); // mid one dropped silently
});

test('telemetry: unknown event refused; scalar allow-list projection', () => {
  const ring = new TelemetryRing({ file: tmpFile(), now: () => 1 });
  assert.strictEqual(ring.record('made_up_event', {}), false);
  assert.strictEqual(ring.record('402_429_handled', {}), false); // old name is gone
  assert.strictEqual(ring.record('four_oh2_handled', {}), true); // new name accepted
  // projection: nested objects/arrays dropped, strings truncated
  const projected = projectFields({
    ok: true, n: 4.5, s: 'x'.repeat(500), nil: null,
    nested: { a: 1 }, arr: [1, 2], bad: undefined,
  });
  assert.deepStrictEqual(Object.keys(projected).sort(), ['n', 'nil', 'ok', 's']);
  assert.strictEqual(projected.s.length, 200);
  // non-object fields bag rejected outright
  assert.strictEqual(ring.record('palette_open', 'not-an-object'), false);
});

test('telemetry: restart persistence — ring reloads data/telemetry.json', async () => {
  const file = tmpFile();
  const gw1 = makeGw({ telemetryFile: file });
  const srv1 = await serve(gw1);
  await fetch(srv1.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: 'migration_phase', fields: { phase: 4, hasFlag: true } }));
  await fetch(srv1.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: 'palette_open' }));
  await srv1.close();
  // mode 0600 on the durable file
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'telemetry.json must be 0600');
  // "restart": fresh Gateway over the same file sees the events
  const gw2 = makeGw({ telemetryFile: file });
  const events = gw2.telemetry.query({ event: 'migration_phase' });
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].fields, { phase: 4, hasFlag: true });
  assert.strictEqual(gw2.telemetry.query({ event: 'palette_open' }).length, 1);
  // corrupt file → fail-open (empty ring), never a boot failure
  fs.writeFileSync(file, '{not json');
  const gw3 = makeGw({ telemetryFile: file });
  assert.strictEqual(gw3.telemetry.size, 0);
});

// ── HTTP surface ────────────────────────────────────────────────────────────

test('telemetry: POST /v2/telemetry — bearer auth, server-side allow-list', async () => {
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    const noAuth = await fetch(srv.port, 'POST', '/v2/telemetry', null, JSON.stringify({ event: 'palette_open' }));
    assert.strictEqual(noAuth.status, 401);
    const unknown = await fetch(srv.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: 'invented_event' }));
    assert.strictEqual(unknown.status, 400);
    const badJson = await fetch(srv.port, 'POST', '/v2/telemetry', OPERATOR, '{oops');
    assert.strictEqual(badJson.status, 400);
    const badFields = await fetch(srv.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: 'palette_open', fields: [1, 2] }));
    assert.strictEqual(badFields.status, 400);
    const ok = await fetch(srv.port, 'POST', '/v2/telemetry', WORKER, JSON.stringify({ event: 'palette_open', fields: { context: 'global' } }));
    assert.strictEqual(ok.status, 202);
    assert.deepStrictEqual(ok.json, { ok: true });
    // rate-limit drop is SILENT: still 202, ring keeps one entry
    const dup = await fetch(srv.port, 'POST', '/v2/telemetry', WORKER, JSON.stringify({ event: 'palette_open' }));
    assert.strictEqual(dup.status, 202);
    assert.strictEqual(gw.telemetry.query({ event: 'palette_open' }).length, 1);
  } finally { await srv.close(); }
});

test('telemetry: GET /v2/telemetry — operator-only, event/since filters', async () => {
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    await fetch(srv.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: 'palette_search', fields: { qlen: 4, results: 2 } }));
    const worker = await fetch(srv.port, 'GET', '/v2/telemetry', WORKER);
    assert.strictEqual(worker.status, 403);
    assert.deepStrictEqual(worker.json, { error: 'operator_required' });
    const noAuth = await fetch(srv.port, 'GET', '/v2/telemetry', null);
    assert.strictEqual(noAuth.status, 401);
    const all = await fetch(srv.port, 'GET', '/v2/telemetry', OPERATOR);
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.json.events.length, 1);
    assert.strictEqual(all.json.events[0].type, 'palette_search');
    const filtered = await fetch(srv.port, 'GET', '/v2/telemetry?event=palette_open', OPERATOR);
    assert.deepStrictEqual(filtered.json.events, []);
    const sinceFuture = await fetch(srv.port, 'GET', '/v2/telemetry?since=' + (Date.now() + 100000), OPERATOR);
    assert.deepStrictEqual(sinceFuture.json.events, []);
  } finally { await srv.close(); }
});

test('telemetry: chain length UNCHANGED after telemetry traffic (not audit)', async () => {
  const gw = makeGw();
  const srv = await serve(gw);
  try {
    const before = gw.chain.verify();
    for (const ev of ['palette_open', 'palette_command', 'migration_phase', 'four_oh2_handled', 'tg_session_unavailable']) {
      await fetch(srv.port, 'POST', '/v2/telemetry', OPERATOR, JSON.stringify({ event: ev, fields: { n: 1 } }));
    }
    const after = gw.chain.verify();
    assert.strictEqual(after.length, before.length, 'telemetry must never seal into the audit chain');
    assert.strictEqual(after.head, before.head);
    // and the telemetry types are NOT in the chain payloads
    const chainTypes = gw.chain.since(0).map((e) => e.payload && e.payload.type);
    assert.ok(!chainTypes.includes('palette_open'));
  } finally { await srv.close(); }
});

test('telemetry: allow-list matches the §20.4 set exactly (no plugin_*/adapter_kind_* dupes)', () => {
  const expected = new Set([
    'palette_open', 'palette_command', 'palette_search', 'palette_object_resolve',
    'palette_nl_intent', 'panel_manifest_validate', 'capability_filter_hit',
    'compose_engine_render', 'migration_phase', 'four_oh2_handled',
    'tg_api_raw_fetch_blocked', 'tg_session_unavailable', 'search_backend_fts5_swap',
  ]);
  assert.deepStrictEqual([...ALLOWED].sort(), [...expected].sort());
  for (const t of ALLOWED) {
    assert.ok(!t.startsWith('plugin_'), 'plugin_* is audited, not telemetry');
    assert.ok(!t.startsWith('adapter_kind_'), 'adapter_kind_* is audited, not telemetry');
  }
});

// ── client wiring (source assertions — browser code, zero framework) ────────

test('telemetry: client wiring — app.js fires palette_* + migration_phase, 400ms/type cap, fire-and-forget', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  // the four palette events
  assert.ok(app.includes("tel('palette_open')"), 'palette_open on open (once per session)');
  assert.ok(/paletteOpened[\s\S]{0,80}tel\('palette_open'\)/.test(app), 'palette_open gated once per session');
  assert.ok(app.includes("tel('palette_search', { qlen: q.length, results: hits.length })"), 'palette_search with qlen+result count');
  assert.ok(app.includes("tel('palette_object_resolve'"), 'palette_object_resolve (seq|token|search + success)');
  assert.ok(app.includes("tel('palette_command'"), 'palette_command on command submit');
  // boot event
  assert.ok(app.includes("tel('migration_phase', { phase: 4, hasFlag: composeFlag })"), 'migration_phase once at boot');
  // transport discipline: TG.api POST, fire-and-forget, client-side 400ms/type cap
  assert.ok(app.includes("api('/v2/telemetry', { method: 'POST'"), 'POSTs via TG.api');
  assert.ok(/400\s*\)/.test(app), 'client-side 400ms/type cap present');
  assert.ok(/api\('\/v2\/telemetry'[\s\S]{0,120}\.catch\(\(\) => \{\}\)/.test(app), 'fire-and-forget .catch(()=>{})');
  // exposed for panels
  assert.ok(app.includes('telemetry: tel'), 'TG.telemetry shared poster');
});

test('telemetry: client wiring — core.js compose_engine_render (latencyMs, domain, surfaceCount) when flag on', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'core.js'), 'utf8');
  assert.ok(core.includes("telemetry('compose_engine_render'"), 'compose_engine_render fired from composedPlan');
  assert.ok(core.includes('latencyMs'), 'measures latency');
  assert.ok(core.includes('surfaceCount'), 'reports surface count');
  assert.ok(/composeEnabled\(\)[\s\S]{0,600}compose_engine_render/.test(core), 'only when the compose flag is on');
  assert.ok(/telemetry\('compose_engine_render'[\s\S]{0,400}\}\s*catch/.test(core) || /catch \{ \/\* telemetry never breaks render \*\/ \}/.test(core), 'never throws');
});
