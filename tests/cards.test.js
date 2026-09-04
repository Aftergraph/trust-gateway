'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// tests/cards.test.js — Adaptive Cards slice (mount 57 + panel + validator).
// Covers: mount loads, 401 without auth, validation accepts valid + rejects invalid,
// renderer uses textContent only (no innerHTML).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PANEL = path.join(__dirname, '..', 'app', 'panels', 'cards.js');
const MOUNT = path.join(__dirname, '..', 'src', 'gateway', 'mounts', '57-cards.js');
const CARDS = path.join(__dirname, '..', 'app', 'cards.js');

// ── static contract ──────────────────────────────────────────────────────
test('mount file exists', () => {
  assert.ok(fs.existsSync(MOUNT), 'src/gateway/mounts/57-cards.js exists');
});

test('panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/cards.js exists');
});

test('XSS: no innerHTML usage anywhere in the panel source', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'must never assign innerHTML');
  assert.ok(!/\.outerHTML\s*[+]?=/.test(js), 'must never assign outerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'must never use insertAdjacentHTML');
  assert.ok(js.includes('textContent'), 'uses textContent');
});

test('XSS: no innerHTML usage anywhere in cards.js source', () => {
  const js = fs.readFileSync(CARDS, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'must never assign innerHTML');
  assert.ok(!/\.outerHTML\s*[+]?=/.test(js), 'must never assign outerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'must never use insertAdjacentHTML');
  assert.ok(js.includes('textContent'), 'uses textContent');
});

test('registers {id,title,render} on window.TG_PANELS', () => {
  const container = { children: [] };
  const code = fs.readFileSync(PANEL, 'utf8');
  const fn = new Function('window', code + '\n;return window;');
  const fakeWindow = { TG_PANELS: [] };
  fn(fakeWindow);
  const panels = fakeWindow.TG_PANELS;
  assert.equal(panels.length, 1, 'panel registered itself');
  assert.deepEqual(
    { id: panels[0].id, title: panels[0].title },
    { id: 'cards', title: 'Adaptive Cards' }
  );
});

// ── validation tests ──────────────────────────────────────────────────────
test('validation function exists in cards.js', () => {
  const js = fs.readFileSync(CARDS, 'utf8');
  assert.ok(js.includes('validateCardDocument'), 'validateCardDocument function exists');
});

test('validation function exports from cards.js', () => {
  const moduleExports = require(CARDS);
  assert.ok(moduleExports.validateCardDocument, 'validateCardDocument should be exported');
});

// ── live HTTP tests ──────────────────────────────────────────────────────
test('mount loads and routes correctly', async () => {
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({
    bots: {
      test: { name: 'test', token: 'tok-test', role: 'operator', capabilities: ['*'] }
    },
    mountFiles: true,
  });

  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const base = 'http://127.0.0.1:' + port;

  try {
    // Test unauthenticated request -> 401
    const unauth = await httpCall(base, 'POST', '/v2/cards/validate', { body: '{}' });
    assert.equal(unauth.status, 401, 'unauthenticated should get 401');

    // Test authenticated valid request
    const valid = await httpCall(base, 'POST', '/v2/cards/validate', {
      body: JSON.stringify({ type: 'card', title: 'Test', content: 'Hello' }),
      token: 'tok-test'
    });
    assert.equal(valid.status, 200, 'valid request should succeed');

    // Test authenticated invalid request (unknown type)
    const invalid = await httpCall(base, 'POST', '/v2/cards/validate', {
      body: JSON.stringify({ type: 'unknown', title: 'Test' }),
      token: 'tok-test'
    });
    assert.equal(invalid.status, 400, 'invalid type should get 400');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('GET /v2/cards lists recent cards', async () => {
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({
    bots: {
      test: { name: 'test', token: 'tok-test', role: 'operator', capabilities: ['*'] }
    },
    mountFiles: true,
  });

  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const base = 'http://127.0.0.1:' + port;

  try {
    // First validate a card
    await httpCall(base, 'POST', '/v2/cards/validate', {
      body: JSON.stringify({ type: 'card', title: 'Test', content: 'Hello' }),
    });

    // Then list cards
    const list = await httpCall(base, 'GET', '/v2/cards', { token: 'tok-test' });
    assert.equal(list.status, 200);
    const data = JSON.parse(list.body);
    assert.ok(Array.isArray(data.cards), 'should return cards array');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

function httpCall(base, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const headers = {};
    if (token !== undefined) {
      headers.authorization = 'Bearer ' + token;
    }
    if (body) {
      headers['content-type'] = 'application/json';
    }
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
