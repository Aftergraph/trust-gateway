'use strict';
// H5 TDD — Authority detail drawer: klik på lease/mission → vis detaljer.
// Leases: revocation-historik, delegation tree (parent-child), budget-forbrug.
// Missions: state-transitions, linked leases.
// Fail-closed: utilgængelig data = ærlig fejlvisning.
// XSS-loven: textContent only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'authority.js'), 'utf8'
);

test('H5: click-handler på item-række åbner detail-drawer', () => {
  assert.match(src, /addEventListener\s*\(\s*['"]click['"]/,
    'rækker skal have click-handler');
  assert.match(src, /drawer|detail/i, 'drawer-koncept');
});

test('H5: drawer viser revocation-historik for leases', () => {
  assert.match(src, /revok|revocation|histor/i,
    'revocation-data skal vises');
});

test('H5: drawer viser delegation tree (parent-child)', () => {
  assert.match(src, /parent|child|delegat|depth/i,
    'delegation-struktur skal vises');
});

test('H5: drawer har luk-knap', () => {
  assert.match(src, /luk|close/i, 'luk-knap');
});

test('H5: XSS-loven — ingen innerHTML', () => {
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
});
