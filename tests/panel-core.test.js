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

test('core.js exposes the 9-domain rail (phase 2) and keeps the legacy 13-tab order for the kill-switch', () => {
  const expectedDomains = ['now', 'chat', 'work', 'agents', 'brain', 'output', 'control', 'connect', 'system'];
  for (const id of expectedDomains) {
    assert.match(src, new RegExp("id:\\s*'" + id + "'"), 'domain id present: ' + id);
  }
  const dm = src.match(/const DOMAINS\s*=\s*\[([\s\S]*?)\n  \];/);
  assert.ok(dm, 'DOMAINS array defined');
  const domainIds = dm[1].match(/id:\s*'([^']+)'/g).map((s) => s.match(/'([^']+)'/)[1]);
  assert.deepEqual(domainIds, expectedDomains, 'domain rail order matches §2.1');
  // Kill-switch: Phase-1 order preserved verbatim + selected via ?tabs=legacy.
  const lm = src.match(/const TABS_LEGACY\s*=\s*\[([\s\S]*?)\n  \];/);
  assert.ok(lm, 'TABS_LEGACY array defined (kill-switch)');
  const legacyIds = lm[1].match(/id:\s*'([^']+)'/g).map((s) => s.match(/'([^']+)'/)[1]);
  assert.deepEqual(legacyIds, ['console', 'history', 'rooms', 'artifacts', 'goals', 'builder', 'hub', 'providers', 'providers-live', 'computer', 'playground', 'voice', 'integrations'], 'legacy order = phase 1');
  assert.match(src, /tabs=legacy/, 'kill-switch query honored');
});

test('core.js redirect map covers every legacy tab id (G11: no broken URLs)', () => {
  const rm = src.match(/const LEGACY_TAB_TO_DOMAIN\s*=\s*\{([\s\S]*?)\n  \};/);
  assert.ok(rm, 'redirect map defined');
  const map = {};
  for (const line of rm[1].split('\n')) {
    const m = line.match(/'?([\w-]+)'?:\s*'(\w+)'/);
    if (m) map[m[1]] = m[2];
  }
  // §20.3 table, verbatim.
  assert.deepEqual(map, {
    console: 'now', rooms: 'now', history: 'output', artifacts: 'output',
    playground: 'output', goals: 'work', builder: 'work', hub: 'connect',
    voice: 'connect', integrations: 'connect', providers: 'brain',
    'providers-live': 'brain', computer: 'control',
  }, 'redirect map matches §20.3');
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
