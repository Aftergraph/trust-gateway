'use strict';
// P1 A11y smoke tests — pins the quality-bar contracts for newly added surfaces.
// Scope: control-bar buttons expose aria-labels; reduced-motion honored in CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');

test('a11y: computer panel control buttons carry aria-labels', () => {
  const s = app('panels/computer.js');
  for (const btn of ['comp-takeover', 'comp-release', 'comp-stop']) {
    assert.ok(s.includes(btn), `${btn} button exists`);
  }
  const labels = (s.match(/aria-label/g) || []).length;
  assert.ok(labels >= 3, `control buttons need aria-labels (found ${labels})`);
});

test('a11y: no innerHTML in newly added control-bar code (textContent-only law)', () => {
  const s = app('panels/computer.js');
  // the panel already followed textContent-only; pin it for the control bar section
  const bar = s.slice(s.indexOf('comp-control'));
  assert.ok(!/innerHTML/.test(bar), 'control bar must not use innerHTML');
});

test('a11y: reduced-motion media query present in responsive.css or style.css', () => {
  const resp = app('responsive.css');
  const style = app('style.css');
  const hasReducedMotion = /prefers-reduced-motion/.test(resp) || /prefers-reduced-motion/.test(style);
  assert.ok(hasReducedMotion, 'prefers-reduced-motion must be honored somewhere');
});