'use strict';
// G4 TDD — mission-detail drawer viser per-item hash-verdict.
// WORKS Evidence (G1) bærer nu Hash. Drawer beregner verdict KUN som
// visning af WORKS' eget verdict (G3: Verify = ok/tampered/unsealed).
// TG mangler RecomputedHash-konteksten? NEJ — WORKS evidence-hash er
// SHA-256 over identitet+udfald; TG kan IKKE rekalkulere uden WORKS-pakken.
// Så verdict hentes IKKE fra TG — drawer viser hash-tilstede/tom ærligt:
//   Hash tilstede (64 hex) → [hash forseglet]
//   Hash tom              → [unsealed]
// Det er fail-closed: TG påstår aldrig "ok" uden WORKS-verify.
// (Fuld verdict-visning kræver verify-endpoint på WORKS — G3 webui har den.)
const test = require('node:test');
const assert = require('node:assert/strict');

test('G4: drawer viser hash-status pr. evidence-item (statisk kontrakt)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.match(src, /ev-hash|hash forseglet|unsealed/, 'hash-status visning');
  assert.match(src, /\.hash\b|\[hash/, 'hash-felt brugt');
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
  // fail-closed: TG påstår aldrig ok på eget initiativ (ingen lokal verify-claim)
  assert.ok(!/verify: 'ok'/.test(src), 'ingen lokal ok-claim');
});
