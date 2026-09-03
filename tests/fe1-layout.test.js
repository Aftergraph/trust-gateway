'use strict';
// FE1: /now layout fix — source-level assertions.
// Root cause 1: #panel-host (flex:1) was inserted before main.panes (also
// flex:1) even when empty, splitting the body column 50/50 — the dead band
// under the header on /now. core.js must toggle .panel-host-empty.
// Root cause 2: desktop.css display:contents on #paneWorkforce detached the
// WORKFORCE title from its body/chatdock at ≥1400px.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

test('core.js toggles panel-host-empty on shell init and every panel transition', () => {
  const core = read('panels/core.js');
  assert.match(core, /function\s+syncHostEmpty\s*\(/, 'syncHostEmpty helper exists');
  assert.match(core, /panel-host-empty/, 'panel-host-empty class referenced');
  // the empty state must be recomputed after console clear + panel mounts
  const showPanel = core.slice(core.indexOf('function showPanel'), core.indexOf('function composedPlan'));
  assert.match(showPanel, /syncHostEmpty\(/, 'showPanel calls syncHostEmpty');
  const switchDomain = core.slice(
    core.indexOf('function switchDomain'),
    core.indexOf('function showPanel'));
  assert.match(switchDomain, /syncHostEmpty\(/, 'switchDomain calls syncHostEmpty');
  // initial shell state starts collapsed (host is empty at insert time)
  const ensureShell = core.slice(
    core.indexOf('function ensureShell'),
    core.indexOf('function buildTabs'));
  assert.match(ensureShell, /panel-host-empty/, 'shell created with panel-host-empty');
});

test('style.css hides an empty panel-host (+ :has() progressive enhancement)', () => {
  const css = read('style.css');
  assert.match(css, /\.panel-host\.panel-host-empty\s*\{\s*display:\s*none/, 'class rule present');
  assert.match(css, /\.panel-host:has\(/, ':has() enhancement present');
});

test('style.css header density: queue strip inline with rail above 1280px', () => {
  const css = read('style.css');
  assert.match(css, /@media\s*\(min-width:\s*1281px\)/, 'single-row breakpoint at 1281px');
  const mq = css.slice(css.indexOf('@media (min-width: 1281px)'), css.indexOf('@media (min-width: 1281px)') + 500);
  assert.match(mq, /flex-wrap:\s*nowrap/, 'no wrap above 1280px');
  assert.match(mq, /\.now-queue\s*\{\s*order:\s*1/, 'queue strip ordered inline with the rail');
  assert.match(mq, /\.statusbar\s*\{\s*order:\s*2/, 'statusbar after rail');
  assert.match(mq, /\.tokenbox\s*\{\s*order:\s*3/, 'tokenbox last');
});

test('desktop.css: workforce pane stays one unit (title+body+chatdock) at any width', () => {
  const css = read('desktop.css');
  assert.ok(!/display:\s*contents/.test(css), 'no display:contents pane splitting');
  // wide screens keep the pinned 3-pane contract (tests/app.test.js)
  assert.match(css, /grid-template-columns:\s*1\.2fr 1fr 1fr/);
});
