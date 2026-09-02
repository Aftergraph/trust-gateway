'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');

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

test('app.js uses EventSource + v2 endpoints', () => {
  const js = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
  assert.match(js, /EventSource/);
  assert.match(js, /\/v2\/events/);
  assert.match(js, /\/v2\/chat/);
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

test('live HTTP: /v2/events is SSE with auth', async () => {
  const gw = new Gateway({ bots: { a: { token: 'tok-a' } }, staticDir: APP });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const good = '/v2/events?token=' + ['tok', 'a'].join('-');
    const badq = '/v2/events?token=' + ['nope', 'x'].join('-');
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: good }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    res.destroy();
    // bad token rejected
    const bad = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: badq }, resolve).on('error', reject));
    assert.equal(bad.statusCode, 401);
    bad.resume();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
