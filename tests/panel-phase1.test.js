'use strict';
// Phase 1 (§20) regression tests: queue-first NOW strip, ⌘K palette wired to
// /v2/search, and the palette→History seq-jump contract. Source-level checks
// (same style as panel-*.test.js) + one live-contract check of the search
// hits shape that jumpToSeq depends on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app');
const appJs = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(APP, 'panels', 'core.js'), 'utf8');
const histJs = fs.readFileSync(path.join(APP, 'panels', 'history.js'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');

test('app.js: palette opens on ⌘K / Ctrl+K and searches via /v2/search', () => {
  assert.match(appJs, /metaKey\s*\|\|\s*e\.ctrlKey/, 'palette hotkey wired');
  assert.match(appJs, /\/v2\/search\?q=/, 'palette primary channel is /v2/search');
  assert.match(appJs, /jumpToSeq/, 'palette results jump to chain seq (§18.3)');
});

test('app.js: NOW queue strip exists in header on every tab', () => {
  assert.match(appJs, /nowQueue/, 'queue strip id');
  assert.match(appJs, /refreshStrip/, 'strip refresh loop');
  assert.match(coreJs, /id === 'console'/, 'console tab is the 3-pane grid (queue visible without navigating)');
});

test('app.js XSS policy: no innerHTML assignment', () => {
  assert.ok(!/\.innerHTML\s*[+]?=/.test(appJs), 'app.js must never assign innerHTML');
});

test('history.js: jumpToSeq exported and window-fetches around the target seq', () => {
  assert.match(histJs, /function jumpToSeq\(seq\)/, 'jumpToSeq implemented');
  assert.match(histJs, /jumpToSeq,/ , 'jumpToSeq exported on TG_HISTORY');
  assert.match(histJs, /seq - 40/, 'loads a window before the seq (since=seq-40)');
  assert.match(histJs, /hist-jump/, 'highlights the landed row');
});

test('core.js: switchTab binds the shell (callers pass only a tab id)', () => {
  assert.match(coreJs, /switchTab:\s*\(id\)\s*=>\s*switchTab\(shell,\s*id\)/, 'TG_CORE.switchTab(id) shell-bound');
});

test('style.css: phase-1 component tokens exist (strip, palette, jump)', () => {
  assert.match(css, /\.now-queue\s*\{/, 'queue strip styles');
  assert.match(css, /\.has-pending/, 'pending state styling');
  assert.match(css, /\.palette-modal|\.palette-box/, 'palette styles');
  assert.match(css, /\.hist-jump/, 'seq-jump highlight styles');
  assert.match(css, /\.panel-view\.view-show/, 'panel visibility contract (phase 1 fix)');
  assert.match(css, /\.modal\.view-show/, 'modal visibility contract');
});

test('backend contract: /v2/search hits carry numeric seq (jumpToSeq input)', async () => {
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({ bots: { atlas: { token: 'at-tok', role: 'operator', capabilities: ['*'] } } });
  gw._audit({ type: 'chat_action', bot: 'atlas', tool: 'fs.read:x', decision: 'allow', session: 's' });
  const { searchChain } = require('../src/gateway/search');
  const r = searchChain(gw.chain, 'chat_action', { limit: 5 });
  assert.ok(r.hits.length >= 1, 'hit expected');
  assert.equal(typeof r.hits[0].seq, 'number', 'seq is numeric (palette #seq labels + jump)');
});
