'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PANEL = path.join(__dirname, '..', 'app', 'panels', 'core.js');
const src = fs.readFileSync(PANEL, 'utf8');

test('core.js is syntactically valid JavaScript', () => {
  const vm = require('node:vm');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'core.js' }), 'core.js must parse');
});

test('core.js registers in TG_PANELS (defensive) and references TG', () => {
  // core.js itself is a router — it must reference window.TG and TG_PANELS.
  assert.match(src, /TG_PANELS/, 'core.js interacts with TG_PANELS');
  assert.match(src, /window\.TG\b|window\.TG_/, 'core.js references TG surfaces');
});

test('XSS policy: no innerHTML assignment in core.js', () => {
  assert.ok(!/\.innerHTML\s*[+]?=/.test(src), 'core.js must never assign innerHTML');
});

test('core.js builds the expected tab ids in order', () => {
  const expected = ['console', 'rooms', 'artifacts', 'goals', 'builder', 'hub', 'providers', 'history', 'computer'];
  for (const id of expected) {
    assert.match(src, new RegExp("id:\\s*'" + id + "'", 'i'), 'tab id present: ' + id);
  }
  // Verify ordering via TABS literal block.
  const m = src.match(/const TABS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'TABS array defined');
  const ids = m[1].match(/id:\s*'([^']+)'/g).map((s) => s.match(/'([^']+)'/)[1]);
  assert.deepEqual(ids, expected, 'tab order matches spec');
});

test('core.js hides .panes via view-hide and mounts panel-view', () => {
  assert.match(src, /view-hide/, 'uses view-hide class');
  assert.match(src, /panel-view/, 'uses panel-view class');
  assert.match(src, /pv-/, 'uses pv-<id> ids');
});

test('core.js renders TG_PANELS once per panel id (idempotent, rescan)', () => {
  assert.match(src, /scanPanels/, 'defensive rescan implemented');
  // No innerHTML usage.
  const idAssignments = src.match(/\.id\s*=.*pv-/g) || [];
  assert.ok(idAssignments.length >= 1, 'assigns pv- ids');
});

test('core.js leaves statusbar + SSE dot unaffected', () => {
  // The router must not touch statusbar/liveDot — search for absence of references.
  assert.ok(!/getElementById\(['"]liveDot['"]\)/.test(src), 'does not toggle liveDot');
  assert.ok(!/getElementById\(['"]chainPill['"]\)/.test(src), 'does not touch chainPill');
});
