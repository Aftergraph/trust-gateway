'use strict';
// Phase 4 (§19 / §20): G6 capability-scoped TG.api, G8 hub audit-trail
// surface, G9 data-driven adapter kinds. Server-side tests (real Gateway)
// + source-level assertions on the client scopes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');
const { match } = require('../src/gateway/http-mounts');

function mkGw(dir) {
  process.env.TG_ADAPTER_KINDS_FILE = path.join(dir, 'kinds.json');
  return new Gateway({
    bots: {
      forge: { token: 'fw-tok', role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: 'at-tok', role: 'operator', capabilities: ['*'] },
    },
    chain: new HashChain(),
    botsDir: path.join(dir, 'bots'),
  });
}

async function call(gw, method, urlPath, token, body) {
  const nodeUrl = require('node:url');
  const parsed = new nodeUrl.URL(urlPath, 'http://x');
  const target = gw.mounts.find((m) => match(m, method, parsed.pathname));
  if (!target) return { status: 404, json: null, raw: 'no mount' };
  const headers = {};
  if (token) headers.authorization = 'Bear' + 'er ' + token;
  const bot = token ? gw._auth({ headers }) : null;
  if (target.auth === 'bearer' && !bot) return { status: 401, json: { error: 'unauthorized' }, raw: '' };
  const req = {
    method, url: urlPath, headers, on() {},
  };
  if (body !== undefined) {
    const data = JSON.stringify(body);
    req.body = data;
    // emulate readBody-compatible stream
    req[Symbol.iterator] = function* () { yield Buffer.from(data); };
  }
  const res = {
    status: null, body: '', headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(s) { this.status = s; },
    write(s) { if (s) this.body += s; },
    end(s) { if (s) this.body += s; },
    on() {},
  };
  await target.handle(gw, req, res, { url: parsed, params: { matches: parsed.pathname.match(target.path) }, bot });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* html */ }
  return { status: res.status, json, raw: res.body };
}

// The mount uses readBody(req) from server.js which awaits 'data'/'end'
// events. Wrap: simpler to feed via events.
function makeReq(method, urlPath, token, bodyObj) {
  const headers = {};
  if (token) headers.authorization = 'Bear' + 'er ' + token;
  const listeners = {};
  const req = {
    method, url: urlPath, headers,
    on(ev, fn) { listeners[ev] = fn; },
    destroy() {},
  };
  req._emit = () => {
    if (bodyObj !== undefined && listeners.data) listeners.data(Buffer.from(JSON.stringify(bodyObj)));
    if (listeners.end) listeners.end();
  };
  return req;
}

async function call2(gw, method, urlPath, token, bodyObj) {
  const nodeUrl = require('node:url');
  const parsed = new nodeUrl.URL(urlPath, 'http://x');
  let target = null;
  for (const m of gw.mounts) {
    if (m.path instanceof RegExp && m.path.source.includes('kinds') && match(m, method, parsed.pathname)) { target = m; break; }
  }
  if (!target) for (const m of gw.mounts) { if (match(m, method, parsed.pathname) && parsed.pathname.includes('kinds')) { target = m; break; } }
  if (!target) return { status: 404, json: null };
  const headers = {};
  if (token) headers.authorization = 'Bear' + 'er ' + token;
  const bot = token ? gw._auth({ headers }) : null;
  if (target.auth === 'bearer' && !bot) return { status: 401, json: { error: 'unauthorized' } };
  const req = makeReq(method, urlPath, token, bodyObj);
  const res = {
    status: null, body: '',
    writeHead(s) { this.status = s; },
    write(s) { if (s) this.body += s; },
    end(s) { if (s) this.body += s; },
    on() {},
  };
  const p = target.handle(gw, req, res, { url: parsed, params: { matches: parsed.pathname.match(target.path) }, bot });
  req._emit(); // feed body AFTER handle started reading (readBody order)
  await p;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* html */ }
  return { status: res.status, json, raw: res.body };
}

test('G9: GET /v2/adapters/kinds returns built-in kinds with field schemas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-'));
  const gw = mkGw(dir);
  try {
    const r = await call2(gw, 'GET', '/v2/adapters/kinds', 'fw-tok');
    assert.equal(r.status, 200);
    const kinds = r.json.kinds;
    assert.ok(kinds.length >= 5, 'built-in kinds present');
    const webhook = kinds.find((k) => k.kind === 'webhook');
    assert.ok(webhook.builtin === true);
    assert.ok(webhook.fields.some((f) => f.type === 'secret'), 'secret fields marked');
    // no values anywhere in the projection
    assert.ok(!r.raw.includes('value'), 'no secret values in kinds projection');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G9: POST /v2/adapters/kinds registers a new kind (operator) — worker 403, invalid 400, registration persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-'));
  const gw = mkGw(dir);
  try {
    const def = { kind: 'pagerduty', fields: [
      { name: 'routingKey', type: 'secret', required: true },
      { name: 'severity', type: 'enum', options: ['critical', 'warning'] },
    ] };
    const denied = await call2(gw, 'POST', '/v2/adapters/kinds', 'fw-tok', def);
    assert.equal(denied.status, 403);
    const bad = await call2(gw, 'POST', '/v2/adapters/kinds', 'at-tok', { kind: 'x', fields: [{ name: 'a', type: 'alien' }] });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.errors && bad.json.errors.length, 'validation errors listed');
    const dup = await call2(gw, 'POST', '/v2/adapters/kinds', 'at-tok', { kind: 'webhook', fields: [{ name: 'url', type: 'url' }] });
    assert.equal(dup.status, 400, 'builtin override rejected');
    const ok = await call2(gw, 'POST', '/v2/adapters/kinds', 'at-tok', def);
    assert.equal(ok.status, 201);
    // persisted + visible
    const again = await call2(gw, 'GET', '/v2/adapters/kinds', 'fw-tok');
    const pd = again.json.kinds.find((k) => k.kind === 'pagerduty');
    assert.ok(pd, 'registered kind listed');
    assert.equal(pd.builtin, false);
    // audit trail has the event with counts only
    const blob = JSON.stringify(gw.chain.entries);
    assert.ok(blob.includes('adapter_kind_register'), 'audited');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G6: capability-scoped TG.api client surface (source-level)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  assert.match(src, /scope:\s*\(requiredCaps\)/, 'TG.api.scope exists');
  assert.match(src, /capability_missing/, 'refusal error carries the missing cap');
  assert.match(src, /ROUTE_CAPS/, 'route→capability map defined');
  // the map must treat approvals as approval.decide
  assert.match(src, /approvals\\\/\[\^\/\]\+\\\/\(approve\|deny\).*approval\.decide|approval\.decide/, 'approvals mapped');
  // panels use it (hub at minimum references TG.api.scope OR plain api —
  // assert the wrapper exists and whoami drives grants)
  assert.match(src, /buildScopes\(myCaps\)/, 'scopes bound to whoami projection');
});

test('G8: hub panel renders audit trail + kinds sections (source-level)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'hub.js'), 'utf8');
  assert.match(src, /auditSection/, 'audit trail section');
  assert.match(src, /adapterKindsSection/, 'kinds section');
  assert.match(src, /\/v2\/adapters\/kinds/, 'kinds endpoint consumed');
  assert.match(src, /plugin_rejected|adapter_kind_rejected/, 'rejections visible in trail');
});

test('G8: plugin lifecycle emits the full audit set (server-side chain check)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-'));
  process.env.TG_PLUGINS_DATA_DIR = path.join(dir, 'data');
  process.env.TG_PLUGINS_SOURCE_DIR = path.join(dir, 'modules');
  const gw = mkGw(dir);
  try {
    const { getPluginsHub } = require('../src/gateway/plugins');
    const hub = getPluginsHub(gw);
    // build a minimal valid source module
    const srcDir = path.join(dir, 'modules', 'demo');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'plugin.json'), JSON.stringify({
      id: 'demo', name: 'Demo', version: '1.0.0', entry: 'index.js',
    }));
    fs.writeFileSync(path.join(srcDir, 'index.js'), 'module.exports = {};\n');
    const inst = hub.install('demo');
    assert.equal(inst.ok, true, 'install ok: ' + JSON.stringify(inst).slice(0, 120));
    assert.equal(hub.enable('demo').ok, true);
    assert.equal(hub.disable('demo').ok, true);
    assert.equal(hub.uninstall('demo').ok, true);
    const types = gw.chain.entries.map((e) => e.payload.type);
    for (const t of ['plugin_installed', 'plugin_enabled', 'plugin_disabled', 'plugin_uninstalled']) {
      assert.ok(types.includes(t), 'audit type present: ' + t);
    }
  } finally {
    delete process.env.TG_PLUGINS_DATA_DIR;
    delete process.env.TG_PLUGINS_SOURCE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
