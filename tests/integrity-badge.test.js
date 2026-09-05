// F2 TDD — integrity-badge i mission-detail drawer:
//   - drawer henter GET /v1/audit/verify og viser {ok, length} som badge
//   - ok=false → roed badge 'CHAIN BROKEN' (aldrig skjult)
// Statisk kontrakt + fail-closed.
const test = require('node:test');
const assert = require('node:assert/strict');

test('F2: drawer viser verify-badge (statisk kontrakt)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.match(src, /\/v1\/audit\/verify/, 'verify-kald findes');
  assert.match(src, /chain-verify|verify-badge|integrity/i, 'badge-visning');
  assert.match(src, /CHAIN BROKEN|broken/i, 'broken-visning (aldrig skjult)');
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
});
