// F3 TDD — evidence-result-badges i mission-detail drawer.
// Per WORKS evidence-item vises type + result-badge (pass=grøn, fail=rød,
// warn=gul, skip=grå) + id i monospace. Plus en resumeret linje "N pass / M fail".
// Fail-resultater ALDRIG skjult (samme lov som F2 broken-badge).
const test = require('node:test');
const assert = require('node:assert/strict');

test('F3: drawer viser evidence-result-badges (statisk kontrakt)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.match(src, /evidence-result|ev-result/, 'result-badge klasse');
  assert.match(src, /'pass'/, 'pass-tilfaelde');
  assert.match(src, /'fail'/, 'fail-tilfaelde');
  assert.match(src, /evidence-summary|N pass|pass \//i, 'resultatal resumeret');
  assert.match(src, /recorded_at|type/, 'WORKS evidence-felter brugt');
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
});
