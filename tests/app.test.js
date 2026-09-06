'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { issueTicket } = require('./sse-util');

const APP = path.join(__dirname, '..', 'app');
const ROOT = path.join(__dirname, '..');

test('SPA files exist', () => {
  for (const f of ['index.html', 'app.js', 'style.css']) {
    assert.ok(fs.existsSync(path.join(APP, f)), f + ' exists');
  }
});

test('index.html references app.js and style.css', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.match(html, /\/app\.js/);
  assert.match(html, /\/style\.css/);
  assert.match(html, /Trust Gateway/);
});

test('app.js bruger TG_EVENTS; ingen orphannede es-referencer', () => {
  const js = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
  assert.match(js, /TG_EVENTS/);
  assert.match(js, /\/v2\/chat/);
  // §20-live-fund: connect() kaldte es.close() efter at `es` var fjernet →
  // ReferenceError ved boot → konsollen død. `es` må kun bruges hvis erklæret.
  if (/\bes\.close\(/.test(js)) {
    assert.match(js, /\b(?:let|var|const) es\b/, 'es.close() uden es-deklaration');
  }
});

test('static asset allowlist dækker alle script-src i index.html (anti-drift)', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'gateway', 'server.js'), 'utf8');
  const refs = [...html.matchAll(/<script src="\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 10, 'index.html har mange script-src');
  for (const r of refs) {
    const serverHas = r.startsWith('lib/')
      ? server.includes('lib\\/[')
      : r.startsWith('panels/')
        ? server.includes('panels\\/[')
        : server.includes(r.replace(/\.js$/, '\\.js')) || server.includes(r);
    assert.ok(serverHas, `server-allowlist mangler: ${r}`);
  }
});

test('XSS guard: no innerHTML assignment in app.js', () => {
  const js = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'app.js must never assign innerHTML');
});

test('style.css has 3-pane grid', () => {
  const css = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');
  assert.match(css, /grid-template-columns\s*:\s*1\.2fr 1fr 1fr/);
});

test('live HTTP: gateway serves the SPA', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { authorization: 'Bearer tok-a' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: b }));
    }).on('error', reject);
  });
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(root.ct, /text\/html/);
  assert.match(root.body, /Trust Gateway/);
  assert.match(root.body, /operator console|Operator Console/i);
  const js = await get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.ct, /javascript/);
  const css = await get('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.ct, /text\/css/);
  await new Promise((r) => server.close(r));
});

test('live HTTP: /v2/events requires an SSE ticket (?token= fail-closed)', async () => {
  const gw = new Gateway({ bots: { a: { token: 'tok-a' } }, staticDir: APP });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const base = 'http://127.0.0.1:' + port;
  try {
    // 1. §20: det gamle ?token= er fail-closed væk
    const legacy = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/v2/events?token=' + ['tok', 'a'].join('-') }, resolve).on('error', reject));
    assert.equal(legacy.statusCode, 401);
    legacy.resume();
    // 2. ticket-mint kræver bearer
    const noAuth = await fetch(base + '/v2/events/ticket', { method: 'POST' });
    assert.equal(noAuth.status, 401);
    // 3. mint → stream OK
    const ticket = await issueTicket(base, 'tok-a');
    assert.match(ticket, /^[0-9a-f]{64}$/);
    const stream = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/v2/events?ticket=' + ticket }, resolve).on('error', reject));
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers['content-type'], /text\/event-stream/);
    stream.destroy();
    // 4. single-use: replay af samme ticket → 401
    const replay = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/v2/events?ticket=' + ticket }, resolve).on('error', reject));
    assert.equal(replay.statusCode, 401);
    replay.resume();
    // 5. gibberish ticket → 401
    const junk = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/v2/events?ticket=deadbeef' }, resolve).on('error', reject));
    assert.equal(junk.statusCode, 401);
    junk.resume();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('every panel file is registered in index.html (no orphan panels)', () => {
  const indexHtml = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const files = fs.readdirSync(path.join(APP, 'panels')).filter((f) => f.endsWith('.js'));
  const missing = files.filter((f) => !indexHtml.includes('/panels/' + f));
  assert.deepEqual(missing, [], 'unregistered panel files: ' + missing.join(', '));
});
