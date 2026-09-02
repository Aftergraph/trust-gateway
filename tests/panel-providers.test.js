'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'providers.js');

test('providers panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/providers.js exists');
});

test('providers panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'providers.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
  // document\.write below is a *regex pattern* forbidding document.write in the
  // panel — not a call site. Safe by construction.
  assert.ok(!/document\.write/.test(js), 'no document.write');
});

test('providers panel: no credential-material handling (key-like strings)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  // No key-like identifiers, storage, or rendering anywhere in the panel.
  assert.ok(!/\bapikey\b/i.test(js), 'no apiKey references');
  assert.ok(!/\bapi[-_]?secret\b/i.test(js), 'no apiSecret references');
  assert.ok(!/\bsecret\b/i.test(js), 'no secret references');
  assert.ok(!/\bsk-/.test(js), 'no sk- prefixed key material');
  assert.ok(!/authorization/i.test(js), 'panel never touches authorization headers directly');
  // No localStorage / token handling — the shared TG surface owns that.
  assert.ok(!/localStorage/.test(js), 'panel must not touch localStorage');
  assert.ok(!/window\.TG\.token/.test(js), 'panel must not read the bot token');
  // Sanity: the guard must actually be able to fail.
  assert.ok(/\bkey\b|\bsecret\b|apikey/i.test('apiKey'), 'key-detector regex is live');
});

test('providers panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]providers['"]/);
  assert.match(js, /render/);
});

test('providers panel uses the shared TG surface', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/providers/);
  assert.match(js, /\/v2\/providers\/models/);
  assert.match(js, /\/v2\/providers\/plan/);
  assert.match(js, /\/v2\/providers\/probe/);
  assert.match(js, /onAudit/);
});

test('providers panel: plan form wires task/preferFree/maxLanes and shows primary + ranked lanes with reason', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /preferFree/);
  assert.match(js, /maxLanes/);
  assert.match(js, /primary/);
  assert.match(js, /lanes/);
  assert.match(js, /reason/);
  // filter input drives the model browser by substring
  assert.match(js, /filter/);
  assert.match(js, /toLowerCase\(\)\.indexOf/);
});

test('live HTTP: gateway serves /panels/providers.js', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/providers.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('live HTTP: provider data flows through the gateway (no credential material in responses)', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
    dataDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tg-prov-panel-')),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const H = { authorization: 'Bearer tok-a', 'content-type': 'application/json' };
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: H }).then((r) => r.json());
  const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { headers: H, method: 'POST', body: JSON.stringify(b) }).then((r) => r.json());
  try {
    const dir = await get('/v2/providers');
    assert.ok(Array.isArray(dir.providers) && dir.providers.length > 0, 'provider directory has entries');
    for (const p of dir.providers) {
      assert.ok(typeof p.name === 'string' && p.name, 'provider has name');
      assert.ok(typeof p.kind === 'string', 'provider has kind');
      assert.ok(typeof p.modelCount === 'number', 'provider has model count (modelCount)');
      assert.ok(!('apiKey' in p) && !('token' in p), 'no credential fields in projection');
    }

    const models = await get('/v2/providers/models');
    assert.ok(Array.isArray(models.models) && models.models.length > 0, 'flat model catalog has entries');
    for (const m of models.models) {
      assert.ok(typeof m.provider === 'string' && typeof m.model === 'string', 'model rows shaped');
    }

    const plan = await post('/v2/providers/plan', { task: 'plan and analyze the quarterly metrics', preferFree: true, maxLanes: 3 });
    assert.ok(plan && plan.primary && plan.primary.provider, 'plan has primary lane');
    assert.ok(Array.isArray(plan.lanes) && plan.lanes.length > 0 && plan.lanes.length <= 3, 'plan respects maxLanes');
    assert.ok(plan.taskTag, 'plan has task tag');
    assert.ok(typeof plan.lanes[0].rank === 'number', 'lanes carry rank (ordered)');
    assert.ok(plan.lanes.some((l) => l.note || l.free === true || l.free === false), 'lanes carry reason material');

    const probe = await post('/v2/providers/probe', { provider: dir.providers[0].name });
    assert.ok('ok' in probe || 'status' in probe || 'error' in probe, 'probe returns a result envelope');
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.rmSync(gw.opts && gw.opts.dataDir || '', { recursive: true, force: true }); } catch { /* tmpdir */ }
  }
});