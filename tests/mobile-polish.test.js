// D1 TDD — mobil-polish: chat-tråd som fuldskærms-view på narrow screens.
// responsive.css får:
//   - @media (max-width:800px): .room-log fuldskærm (position fixed over resten
//     når et rum er åbent), compose pinned til bund (100dvh - tastatur via
//     interactive-widget), safe-area-padding, tap-targets >= 44px
//   - prefers-reduced-motion er allerede i style.css (bevares)
// Statisk kontrakt: disse selektorer + properties findes.
const test = require('node:test');
const assert = require('node:assert/strict');

test('D1: mobil chat-fuldskærm CSS-kontrakt', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'responsive.css'), 'utf8');
  assert.match(css, /@media \(max-width:\s*800px\)/, 'mobile breakpoint');
  assert.match(css, /\.room-log[\s\S]*position:\s*fixed/, 'room-log fuldskærm');
  assert.match(css, /\.room-send[\s\S]*bottom|room-send[\s\S]*fixed/, 'compose pinned');
  assert.match(css, /env\(safe-area-inset-bottom\)/, 'safe-area');
  assert.match(css, /interactive-widget|100dvh/, 'tastatur-håndtering');
});

test('D1: tap-targets >= 44px paa mobil', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'responsive.css'), 'utf8');
  assert.match(css, /min-height:\s*44px/, 'tap-target min-height');
});

test('D1: prefers-reduced-motion stadig til stede (P1-accessibility bevaret)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'style.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion bevaret');
});
