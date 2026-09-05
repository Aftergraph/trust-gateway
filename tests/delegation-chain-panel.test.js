'use strict';
// Static UI contract tests for the delegation tree panel slice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'rooms.js'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '..', 'app', 'style.css'), 'utf8');

test('rooms panel exposes delegation tab and chain endpoint', () => {
  assert.match(panel, /Delegation/);
  assert.match(panel, /\/v2\/rooms\/.*\/chain/);
  assert.match(panel, /renderDelegationTree/);
});

test('delegation tree remains XSS-safe and dependency-free', () => {
  assert.doesNotMatch(panel, /innerHTML\s*[+]?=/);
  assert.doesNotMatch(panel, /insertAdjacentHTML/);
  assert.match(panel, /createElement|window\.TG\.el/);
});

test('delegation tree has collapsible controls and dark-theme styles', () => {
  assert.match(panel, /delegationNode/);
  assert.match(panel, /toggle-btn/);
  assert.match(panel, /style\.display/);
  assert.match(style, /\.delegation-root/);
  assert.match(style, /\.delegation-children/);
  assert.match(style, /\.toggle-btn/);
});
