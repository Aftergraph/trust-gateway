'use strict';
// H3 TDD — missions-panel viser per-row integrity-overview:
//   tampered-count (rød, altid synlig hvis >0)
//   unsealed-count (grå)
//   fail-count (eksisterende F3)
// Fail-closed: ingen syntetiske tal — kun fra H1 verdicts.
// XSS-loven: textContent only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8'
);

test('H3: missions-panel henter verdicts for overview badges', () => {
  assert.match(src, /\/v2\/executions\/[^'"]*\/evidence|evidence_verdicts/,
    'panel skal hente verdicts fra H1-endpointet');
});

test('H3: tampered-count badge i proposal-row (aldrig skjult)', () => {
  assert.match(src, /tampered.*count|tamperedCount|tampered-count/i,
    'tampered tæller vist i row');
});

test('H3: fail-closed — 0 tampered vises ikke som alarm (kun >0)', () => {
  // Når tampered=0 skal badge ikke råbe — kun >0 er en alarm
  assert.match(src, /tamperedCount\s*>\s*0|tampered[^>]*>\s*0|\+\s*tampered/,
    'guard mod 0-tampered støj');
});

test('H3: XSS-loven — ingen innerHTML', () => {
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
});
