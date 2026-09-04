'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'hub.js');

test('hub panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/hub.js exists');
});

test('hub panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'hub.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
});

test('hub panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]hub['"]/);
  assert.match(js, /render/);
});

test('hub panel uses the shared TG surface', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/plugins/);
  assert.match(js, /\/v2\/skills/);
  assert.match(js, /\/v2\/mcp/);
  assert.match(js, /onAudit/);
  assert.match(js, /plugin_/);
});

test('hub panel renders the three sections', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /pluginsSection/);
  assert.match(js, /skillsSection/);
  assert.match(js, /mcpSection/);
  // enable/disable + uninstall buttons, install-by-id input, mcp register form
  assert.match(js, /'enable'|'disable'/);
  assert.match(js, /'uninstall'/);
  assert.match(js, /install module by id/);
  assert.match(js, /register/);
});

test('live HTTP: gateway serves /panels/hub.js', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/hub.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('live HTTP: hub data endpoints back the panel (plugins/skills/mcp shape)', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const H = { authorization: 'Bearer tok-a', 'content-type': 'application/json' };
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req2 = http.request({ host: '127.0.0.1', port, path: p, method, headers: H }, (res2) => {
      let b = '';
      res2.on('data', (c) => (b += c));
      res2.on('end', () => resolve({ status: res2.statusCode, body: b ? JSON.parse(b) : {} }));
    }).on('error', reject);
    req2.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const plugins = await call('GET', '/v2/plugins');
    assert.equal(plugins.status, 200);
    assert.ok(Array.isArray(plugins.body.modules));
    const skills = await call('GET', '/v2/skills');
    assert.equal(skills.status, 200);
    assert.ok(Array.isArray(skills.body.skills));
    const mcp = await call('GET', '/v2/mcp');
    assert.equal(mcp.status, 200);
    assert.ok(Array.isArray(mcp.body.servers));
  } finally {
    await new Promise((r) => server.close(r));
  }
});