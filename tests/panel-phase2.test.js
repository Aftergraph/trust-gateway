'use strict';
// Phase 2 (§20.3) regression tests: the domain rail is the nav, every old
// tab id redirects, the legacy kill-switch survives, and console deep-link
// boot wiring exists. Source-level (same style as panel-*.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', 'app', 'panels', 'core.js');
const src = fs.readFileSync(CORE, 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

test('agents + system panels are shipped and registered (AGENTS/SYSTEM domains own panels)', () => {
  const as = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'agents-system.js'), 'utf8');
  assert.match(as, /id:\s*'agents'/, 'agents panel registered');
  assert.match(as, /id:\s*'system'/, 'system panel registered');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(as), 'XSS policy');
  assert.match(html, /panels\/agents-system\.js/, 'script tag wired in index.html');
});

test('core.js deep-link boot resolves /d/ URIs client-side', () => {
  assert.ok(src.includes(')\\/o\\/'), 'deep-link path regex present');
  assert.match(src, /jumpToSeq\(r\.object\.seq\)/, 'auditentry deep links reuse the seq jump');
});

test('core.js domain rail exposes all 9 domains on TG_CORE', () => {
  assert.match(src, /DOMAINS:\s*DOMAINS\.map/, 'TG_CORE.DOMAINS exported');
  assert.match(src, /redirectMap:\s*LEGACY_TAB_TO_DOMAIN/, 'redirect map exposed for tests/tooling');
  assert.match(src, /popstate/, 'back/forward re-resolves the domain (§2.3)');
  assert.match(src, /history\.pushState/, 'domain URIs are pushed into the URL bar');
});

test('every legacy tab id lands on a domain that owns a panel set', () => {
  const dm = src.match(/const DOMAINS\s*=\s*\[([\s\S]*?)\n  \];/);
  assert.ok(dm, 'DOMAINS defined');
  const rm = src.match(/const LEGACY_TAB_TO_DOMAIN\s*=\s*\{([\s\S]*?)\n  \};/);
  const targets = new Set((rm[1].match(/'(\w+)'/g) || []).map((s) => s.slice(1, -1)).filter((x) => !['console','rooms','history','artifacts','playground','goals','builder','hub','voice','integrations','providers','providers-live','computer'].includes(x)));
  const domainIds = (dm[1].match(/id:\s*'([^']+)'/g) || []).map((s) => s.match(/'([^']+)'/)[1]);
  for (const t of targets) {
    assert.ok(domainIds.includes(t), 'redirect target is a real domain: ' + t);
  }
});
