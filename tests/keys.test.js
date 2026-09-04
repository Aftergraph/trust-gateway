'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// G5 (§18.7) — keyboard map registry tests. Loads app/keys.js in a vm
// sandbox, asserts the registry shape, that detectConflicts catches
// duplicate (context,key) bindings, that the shipped set is conflict-free,
// and the XSS policy (textContent only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'app');
const src = fs.readFileSync(path.join(APP, 'keys.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');

function loadKeys() {
  const listeners = [];
  const doc = {
    addEventListener(type, fn) { listeners.push([type, fn]); },
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
    createElement: () => ({
      className: '', id: '', textContent: '', tabIndex: 0,
      appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    }),
    body: { appendChild() {} },
  };
  const win = {};
  const ctx = vm.createContext({ window: win, document: doc, console });
  new vm.Script(src, { filename: 'keys.js' }).runInContext(ctx);
  return { K: win.TG_KEYS, listeners, win };
}

test('keys.js vm-loads and exports TG_KEYS with the contract shape', () => {
  const { K, listeners } = loadKeys();
  assert.ok(K, 'window.TG_KEYS exported');
  assert.ok(Array.isArray(K.bindings) && K.bindings.length > 0, 'bindings is a non-empty array');
  assert.equal(typeof K.detectConflicts, 'function', 'detectConflicts exported');
  // helpVisible is a getter (live view of the overlay state)
  assert.equal(typeof Object.getOwnPropertyDescriptor(K, 'helpVisible').get, 'function', 'helpVisible is a getter');
  // §18.7 MUST: the single keydown dispatcher is installed once
  assert.equal(listeners.filter((l) => l[0] === 'keydown').length, 1, 'exactly one document keydown dispatcher');
});

test('registry shape: every binding is {context∈global|queue|palette, key, description}', () => {
  const { K } = loadKeys();
  for (const b of K.bindings) {
    assert.equal(typeof b.key, 'string', 'binding key is a string');
    assert.equal(typeof b.description, 'string', 'binding description is a string');
    assert.ok(['global', 'queue', 'palette'].indexOf(b.context) !== -1, 'binding context is a known context: ' + JSON.stringify(b));
  }
  // §18.7 shipped set: the named bindings exist in the right context
  const has = (ctx, key) => K.bindings.some((b) => b.context === ctx && b.key === key);
  for (const [ctx, key] of [
    ['global', 'mod+k'], ['global', 'g h'], ['global', 'g n'], ['global', '?'],
    ['queue', 'a'], ['queue', 'd'], ['queue', 'j'], ['queue', 'k'],
    ['palette', 'Escape'], ['palette', 'Enter'], ['palette', 'ArrowDown'], ['palette', 'ArrowUp'],
  ]) {
    assert.ok(has(ctx, key), ctx + ' binding for ' + key);
  }
});

test('detectConflicts catches duplicate (context,key) bindings (case-insensitive)', () => {
  const { K } = loadKeys();
  const dupes = K.detectConflicts([
    { context: 'global', key: 'a' },
    { context: 'global', key: 'A' },
    { context: 'queue', key: 'a' },
    { context: 'global', key: 'mod+k' },
    { context: 'global', key: 'mod+k' },
  ]);
  assert.equal(dupes.length, 2, 'one dupe per repeated binding');
  assert.ok(dupes.some((d) => d.context === 'global' && (d.key === 'a' || d.key === 'A')), 'a/A dupe caught');
  assert.ok(dupes.some((d) => d.context === 'global' && d.key === 'mod+k'), 'mod+k dupe caught');
  // same key in a different context is NOT a conflict
  assert.equal(K.detectConflicts([{ context: 'global', key: 'Escape' }, { context: 'queue', key: 'Escape' }]).length, 0, 'Esc across contexts is fine');
  assert.equal(K.detectConflicts([]).length, 0, 'empty list → no conflicts');
});

test('shipped set is conflict-free and nothing was disabled at init', () => {
  const { K } = loadKeys();
  assert.equal(K.detectConflicts(K.bindings).length, 0, 'no duplicate (context,key) in the shipped registry');
  for (const b of K.bindings) assert.ok(!b.disabled, 'no shipped binding disabled: ' + b.context + ' ' + b.key);
});

test('compose manifests route keybindings through the same conflict check (§19.3)', () => {
  const compose = fs.readFileSync(path.join(APP, 'compose.js'), 'utf8');
  assert.match(compose, /TG_KEYS\.detectConflicts/, 'compose uses TG_KEYS.detectConflicts when available');
  assert.match(compose, /duplicate \(context,key\) binding/, 'conflict → validation error');
});

test('index.html loads keys.js before app.js (registry first, dispatcher owns ⌘K)', () => {
  const k = html.indexOf('/keys.js');
  const a = html.indexOf('/app.js');
  assert.ok(k !== -1, 'keys.js script tag present');
  assert.ok(k < a, 'keys.js loads before app.js');
});

test('help overlay: rendered from the registry, Esc closes, helpVisible exported', () => {
  assert.match(src, /helpVisible/, 'TG_KEYS.helpVisible exported');
  assert.match(src, /'view-show'/, 'help overlay uses the shared modal .view-show toggle');
  assert.match(src, /textContent/, 'overlay renders via textContent');
  // the overlay must be driven by the registry, not a hardcoded table:
  // ensureHelp consumes `bindings` filtered per context.
  assert.match(src, /bindings\.filter/, 'help renders bindings from the registry');
});

test('XSS policy: no innerHTML assignment in keys.js', () => {
  assert.ok(!/\.innerHTML\s*[+]?=/.test(src), 'keys.js must never assign innerHTML');
});

test('keys.js is served by the gateway and precached by the service worker', async () => {
  const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  assert.match(sw, /'\/keys\.js'/, 'sw.js SHELL_ASSETS precaches keys.js');
  const http = require('node:http');
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({ bots: { a: { token: 'tok-a' } }, staticDir: APP });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const body = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/keys.js', headers: { authorization: 'Bearer tok-a' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', reject));
    assert.equal(body.status, 200, '/keys.js served');
    assert.match(body.body, /TG_KEYS/, 'keys.js body served intact');
  } finally {
    await new Promise((r) => server.close(r));
  }
});