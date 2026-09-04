'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'builder.js');

test('builder panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/builder.js exists');
});

test('builder panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'builder.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
});

test('builder panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]builder['"]/);
  assert.match(js, /render/);
});

test('builder panel uses the shared TG surface + agents/profiles endpoints', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/agents/);
  assert.match(js, /\/v2\/profiles\//);
  assert.match(js, /onAudit/);
});

test('builder panel: create form derives capability checkboxes from policy ROLE_CAPABILITIES', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  // hardcoded role cap sets must match src/gateway/policy.js exactly
  const { ROLE_CAPABILITIES } = require('../src/gateway/policy');
  assert.match(js, /ROLE_CAPABILITIES\s*=/);
  for (const [role, caps] of Object.entries(ROLE_CAPABILITIES)) {
    assert.ok(js.includes(role + ': [' + caps.map((c) => "'" + c + "'").join(', ') + ']'),
      'builder.js hardcodes ' + role + ' caps in policy order');
  }
  assert.match(js, /checkbox/);
});

test('builder panel: delete uses confirm(), fail-closed 403/400 messaging', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /window\.confirm\(/, 'delete gated by confirm()');
  assert.match(js, /403/, 'explicit 403 fail-closed message');
  assert.match(js, /400/, 'explicit 400 fail-closed message');
  assert.match(js, /operator token required/, 'inline operator_required message');
});

test('builder panel roles select offers worker/analyst/operator', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /\['worker',\s*'analyst',\s*'operator'\]/);
});

test('builder panel persona inputs are length-capped like the store', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  // server MAX_PERSONA = 2000 (src/gateway/agent-store.js)
  assert.match(js, /maxLength\s*=\s*2000/);
});

test('live HTTP: gateway serves /panels/builder.js', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/builder.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('live HTTP: panel backend contract — create/list/delete agent + profile PUT over real gateway', async () => {
  // hermetic store: never touch the repo's data/agents.json
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-panel-builder-'));
  process.env.TG_DATA_DIR = dataDir;
  const gw = new Gateway({
    bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      worker: { token: 'tok-w', role: 'worker', capabilities: ['fs.read', 'web.get'] },
    },
    staticDir: APP,
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const call = (method, p, tok, body) => new Promise((resolve, reject) => {
    const reqOpts = {
      host: '127.0.0.1', port, path: p, method,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        tok ? { authorization: 'Bearer ' + tok } : {},
      ),
    };
    const r = http.request(reqOpts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  try {
    // operator creates an agent (panel create form payload shape)
    const created = await call('POST', '/v2/agents', 'tok-op',
      { name: 'scribe-bot', role: 'analyst', capabilities: ['fs.read', 'web.get'], persona: 'careful reader' });
    assert.equal(created.status, 201);
    assert.equal(created.body.agent.role, 'analyst');
    assert.deepEqual(created.body.agent.capabilities, ['fs.read', 'web.get']);

    // list shows it (panel list render source)
    const listed = await call('GET', '/v2/agents', 'tok-op');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.agents.some((a) => a.name === 'scribe-bot'));

    // profile read + write via the profiles endpoints (edit form)
    const prof = await call('GET', '/v2/profiles/scribe-bot', 'tok-op');
    assert.equal(prof.status, 200);
    const put = await call('PUT', '/v2/profiles/scribe-bot', 'tok-op',
      { persona: 'careful reader v2', settings: { tone: 'terse' } });
    assert.equal(put.status, 200);
    assert.equal(put.body.profile.settings.tone, 'terse');

    // non-operator delete fails closed with 403 (panel shows inline)
    const denied = await call('DELETE', '/v2/agents/scribe-bot', 'tok-w');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'operator_required');

    // 400 on invented capability (panel checkbox list prevents, server enforces)
    const bad = await call('POST', '/v2/agents', 'tok-op',
      { name: 'inventor', role: 'worker', capabilities: ['made.up.cap'] });
    assert.equal(bad.status, 400);

    // operator delete succeeds (confirm() gate is client-side)
    const gone = await call('DELETE', '/v2/agents/scribe-bot', 'tok-op');
    assert.equal(gone.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});