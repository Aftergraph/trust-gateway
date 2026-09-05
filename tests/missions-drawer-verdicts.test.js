'use strict';
// H2 TDD — mission-detail drawer bruger H1 verdicts (evidence_verdicts fra
// /v2/executions/:workId/evidence) til at vise per-item integrity-status:
//   ok       → grøn [hash ok]
//   tampered → rød [TAMPERED] (aldrig skjult, F2-loven)
//   unsealed → grå [unsealed]
// Fail-closed: verdict-felt tomt/missing → [unsealed] (aldrig falsk "ok").
// XSS-loven: textContent only, ingen innerHTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8'
);

test('H2: missions.js kalder /v2/executions/:id/evidence (H1 endpoint)', () => {
  assert.match(src, /\/v2\/executions\/[^'"]*\/evidence|executions\/.*evidence/,
    'drawer skal kalde evidence-endpointet for at få verdicts');
});

test('H2: drawer renderer verdict-badge (ok/tampered/unsealed)', () => {
  assert.match(src, /evidence_verdicts|verdict/, 'læser verdicts fra response');
  assert.match(src, /tampered|TAMPERED/, 'tampered visning');
  assert.match(src, /unsealed/, 'unsealed visning');
});

test('H2: fail-closed — [hash ok] kun via WORKS verdict (nie lokal beregning)', () => {
  // TG viser [hash ok] KUN når verdict === 'ok' fra WORKS G5 via H1.
  // Ingen lokal hash-beregning eller "ser ok ud"-heuristik.
  assert.match(src, /verdict\s*===?\s*['"]ok['"]/,
    '[hash ok] skal vaere guardet af verdict === ok');
  // XSS-loven
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven: ingen innerHTML');
});

test('H2: tampered/fail fremhævet (aldrig skjult)', () => {
  assert.match(src, /ev-verdict-tampered|verdict.*tampered|has-fail/,
    'tampered har distinkt klasse');
});
