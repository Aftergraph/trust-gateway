'use strict';
// Executions panel tests — static UI contract + fn-route + mount presence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'executions.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'core.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

test('executions panel exists and registers in TG_PANELS', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'app', 'panels', 'executions.js')));
  assert.match(panel, /TG_PANELS/);
  assert.match(panel, /id:\s*['"]executions['"]/);
  assert.match(panel, /title:\s*['"]Executions['"]/);
  assert.match(panel, /render/);
});

test('executions panel is XSS-safe (textContent only, no innerHTML)', () => {
  assert.doesNotMatch(panel, /\.innerHTML\s*[+]?=/);
  assert.doesNotMatch(panel, /insertAdjacentHTML/);
});

test('executions panel calls TG proxy endpoints', () => {
  assert.match(panel, /\/v2\/executions/);
  assert.match(panel, /TG\.api/);
});

test('core.js rail includes executions in the WORK domain', () => {
  assert.match(core, /executions/);
});

test('index.html loads the executions panel script', () => {
  assert.match(index, /panels\/executions\.js/);
});

test('executions panel has state badges and work-row styles', () => {
  assert.match(panel, /stateBadge/);
  assert.match(panel, /exec-row/);
  assert.match(style, /\.exec-row/);
  assert.match(style, /\.exec-state-badge/);
  assert.match(style, /\.st-succeeded/);
});

test('executions panel polls with cleanup (no memory leak)', () => {
  assert.match(panel, /setInterval/);
  assert.match(panel, /clearInterval/);
  assert.match(panel, /MutationObserver/);
});
