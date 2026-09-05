'use strict';
// H4 TDD — Authority panel: AIE leases/missions/admissions synligt i TG SPA.
// Operator-only (132-authority-proxy håndhæver RBAC). Fail-closed:
// utilgængelig AIE → ærlig fejlvisning, aldrig syntetiske data.
// XSS-loven: textContent only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panelPath = path.join(__dirname, '..', 'app', 'panels', 'authority.js');

test('H4: authority-panel findes og registreres i TG_PANELS', () => {
  assert.ok(fs.existsSync(panelPath), 'authority.js skal eksistere');
  const src = fs.readFileSync(panelPath, 'utf8');
  assert.match(src, /TG_PANELS\.push/, 'skal registrere sig selv');
  assert.match(src, /id:\s*['"]authority['"]/i, 'panel-id = authority');
});

test('H4: kalder /v2/authority endpoints (leases/missions/admissions)', () => {
  const src = fs.readFileSync(panelPath, 'utf8');
  assert.match(src, /\/v2\/authority\/leases|\/v2\/authority\b/,
    'skal hente authority-data fra proxy');
});

test('H4: fail-closed — utilgængelig AIE vises ærligt', () => {
  const src = fs.readFileSync(panelPath, 'utf8');
  assert.match(src, /utilgaengelig|unavailable|disabled|fejl|error/i,
    'skal vise ærlig fejl når AIE er nede');
});

test('H4: XSS-loven — ingen innerHTML', () => {
  const src = fs.readFileSync(panelPath, 'utf8');
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven: ingen innerHTML');
});
