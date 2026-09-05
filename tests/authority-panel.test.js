'use strict';
// Authority panel tests — static UI contract + proxy endpoints + rail wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'authority.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'core.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

test('authority panel exists and registers in TG_PANELS', () => {
  assert.match(panel, /TG_PANELS/);
  assert.match(panel, /id:\s*['"]authority['"]/);
  assert.match(panel, /title:\s*['"]Authority['"]/);
  assert.match(panel, /render/);
});

test('authority panel is XSS-safe (textContent only, no innerHTML)', () => {
  assert.doesNotMatch(panel, /\.innerHTML\s*[+]?=/);
  assert.doesNotMatch(panel, /insertAdjacentHTML/);
});

test('authority panel calls TG proxy endpoints', () => {
  assert.match(panel, /\/v2\/authority/);
  assert.match(panel, /TG\.api/);
});

test('authority panel covers all 5 kinds with lease revocation/depth/budget', () => {
  for (const kind of ['leases', 'missions', 'admissions', 'outcomes', 'evidence']) {
    assert.match(panel, new RegExp(kind), kind + ' covered');
  }
  assert.match(panel, /revoked/);
  assert.match(panel, /depth/);
  assert.match(panel, /budget_remaining/);
});

test('core.js rail includes authority in the AGENTS domain', () => {
  assert.match(core, /authority/);
});

test('index.html loads the authority panel script', () => {
  assert.match(index, /panels\/authority\.js/);
});

test('authority panel styles present with revocation colors', () => {
  assert.match(style, /\.auth-row/);
  assert.match(style, /\.auth-badge/);
  assert.match(style, /\.auth-revoked/);
  assert.match(style, /\.auth-active/);
});

test('authority panel polls with cleanup (no memory leak)', () => {
  assert.match(panel, /setInterval/);
  assert.match(panel, /clearInterval/);
  assert.match(panel, /MutationObserver/);
});
