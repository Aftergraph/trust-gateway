'use strict';
// tests/panel-playground.test.js — static lint + serve 200 for the playground panel.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PANEL = path.join(__dirname, '..', 'app', 'panels', 'playground.js');

// ── static contract ──────────────────────────────────────────────────────
test('panel file exists and is referenced by index.html', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/playground.js exists');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(html, /\/panels\/playground\.js/, 'index.html loads playground.js');
});

test('XSS: no innerHTML usage anywhere in the panel source', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'must never assign innerHTML');
  assert.ok(!/\.outerHTML\s*[+]?=/.test(js), 'must never assign outerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'must never use insertAdjacentHTML');
  assert.ok(js.includes('textContent'), 'uses textContent');
});

test('registers {id,title,render} on window.TG_PANELS', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  assert.match(src, /TG_PANELS/, 'interacts with TG_PANELS');
  assert.match(src, /id:\s*'playground'/, 'id is playground');
  assert.match(src, /title:\s*'Playground'/, 'title is Playground');
  assert.match(src, /render/, 'has render function');
});

test('panel syntax is valid JavaScript', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(PANEL, 'utf8');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'playground.js' }), 'playground.js must parse');
});
