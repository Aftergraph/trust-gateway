'use strict';
// FE2 (craft): surface polish within the token system — rail accents, row
// rhythm, empty states, transitions/focus rings, scrollbars, one-shot NOW
// pulse. Source-level assertions (same style as panel-*.test.js) pinning the
// craft contract: everything flows from --tg-* tokens, no remote assets, no
// innerHTML, and the only JS logic change is the .just-changed hook in
// app.js refreshStrip + the .clickable hook in history.js renderRows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app');
const css = fs.readFileSync(path.join(APP, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
const histJs = fs.readFileSync(path.join(APP, 'panels', 'history.js'), 'utf8');

// Pull a rule block for a selector (last occurrence wins, like the cascade).
function ruleFor(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m, last = null;
  while ((m = re.exec(css))) last = m[1];
  return last;
}

test('fe2 style.css: token discipline — no new color literals outside :root', () => {
  const noRoot = css.replace(/:root\s*\{[^}]*\}/gs, '');
  const stray = noRoot.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepStrictEqual(stray, [], 'all hex colors must live in :root token blocks: ' + stray.join(','));
  assert.ok(!/@import/.test(css), 'no @import');
  assert.ok(!/url\(\s*["']?https?:/.test(css), 'no remote url()');
});

test('fe2 rail: active domain button gets left-accent + background lift', () => {
  const active = ruleFor('.tab.domain.active');
  assert.ok(active, '.tab.domain.active rule exists');
  assert.match(active, /inset\s+3px\s+0\s+0\s+var\(--tg-risk-read\)/, 'left accent via inset box-shadow (no layout shift)');
  assert.match(active, /background:\s*var\(--tg-bg-hover\)/, 'background lift uses the hover surface token');
});

test('fe2 rail: subtab underline animates via transform, not layout', () => {
  assert.match(css, /\.subtab::after\s*\{/, 'underline is a pseudo-element');
  assert.match(css, /\.subtab\.active::after\s*\{[^}]*transform:\s*scaleX\(1\)/, 'active state scales the underline in');
  const after = ruleFor('.subtab::after');
  assert.match(after, /transform:\s*scaleX\(0\)/, 'resting state scales it out');
  assert.match(after, /transition:\s*transform\s+120ms\s+ease/, 'transform-based transition (no width/border animation)');
  assert.ok(!/\.subtab[^{]*\{[^}]*transition:[^}]*(width|border-bottom-color)/.test(css), 'no layout-property underline transition');
});

test('fe2 panels: active .panel-view hairline top-border in accent token', () => {
  assert.match(css, /\.panel-view\.view-show\s*\{[^}]*border-top:\s*1px\s+solid\s+var\(--tg-border-accent\)/, 'active view hairline');
});

test('fe2 rows: 4/8px rhythm + hover lift on .row/.botrow/.hub-row', () => {
  for (const sel of ['.row', '.botrow', '.hub-row']) {
    const r = ruleFor(sel);
    assert.ok(r, sel + ' rule exists');
    assert.match(r, /padding:\s*var\(--tg-space-1\)\s+var\(--tg-space-2\)/, sel + ' uses the 4/8px spacing tokens');
  }
  const hover = ruleFor('.row:hover, .botrow:hover, .hub-row:hover');
  assert.ok(hover, 'grouped row hover rule exists');
  assert.match(hover, /background:\s*var\(--tg-bg-hover\)/, 'hover lift uses the hover surface token');
});

test('fe2 rows: .clickable hook lives in history.js renderRows only', () => {
  assert.match(histJs, /renderRows[\s\S]{0,400}el\('div',\s*'row clickable'/, 'renderRows stamps rows clickable');
  const appDir = path.join(APP, 'panels');
  const offenders = fs.readdirSync(appDir)
    .filter((f) => f.endsWith('.js') && f !== 'history.js')
    .filter((f) => fs.readFileSync(path.join(appDir, f), 'utf8').includes('clickable'));
  offenders.push(...(appJs.includes('clickable') ? ['app.js'] : []));
  assert.deepStrictEqual(offenders, [], 'clickable must not leak into other panels: ' + offenders.join(','));
  assert.match(css, /\.clickable\s*\{[^}]*cursor:\s*pointer/, 'clickable gets pointer affordance');
});

test('fe2 empty states: centered muted block with dashed border', () => {
  const empty = ruleFor('.empty');
  assert.match(empty, /border:\s*1px\s+dashed\s+var\(--tg-border\)/, 'dashed hairline');
  assert.match(empty, /text-align:\s*center/, 'centered');
  assert.match(empty, /color:\s*var\(--tg-text-muted\)/, 'muted text');
  assert.match(empty, /margin:[^;]*auto/, 'block centered horizontally');
});

test('fe2 controls: 120ms ease transitions + :focus-visible 2px read-risk ring', () => {
  assert.match(css, /\.btn,\s*\.tab,\s*\.subtab\s*\{[^}]*transition:[^;]*120ms\s+ease/, '120ms ease on interactive controls');
  const focus = ruleFor('.btn:focus-visible, .tab:focus-visible, .subtab:focus-visible');
  assert.ok(focus, ':focus-visible rule exists');
  assert.match(focus, /outline:\s*2px\s+solid\s+var\(--tg-risk-read\)/, '2px read-risk outline');
  assert.ok(!/\.btn:focus\s*\{|\.tab:focus\s*\{|\.subtab:focus\s*\{/.test(css), 'mouse clicks must not show the ring (focus-visible only)');
});

test('fe2 scrollbars: thin styled bars on .panel-view/.pane-body/.chatlog using surface tokens', () => {
  assert.match(css, /\.panel-view,\s*\.pane-body,\s*\.chatlog\s*\{[^}]*scrollbar-width:\s*thin/, 'Firefox: thin scrollbar');
  assert.match(css, /scrollbar-color:\s*var\(--tg-border-strong\)\s+transparent/, 'Firefox: surface-token thumb, transparent track');
  for (const sel of ['.panel-view::-webkit-scrollbar', '.pane-body::-webkit-scrollbar', '.chatlog::-webkit-scrollbar']) {
    assert.ok(css.includes(sel), 'webkit rule for ' + sel);
  }
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--tg-border-strong\)/, 'webkit thumb uses surface token');
  assert.match(css, /::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/, 'webkit track is transparent');
});

test('fe2 NOW strip: .just-changed pulses exactly once per pending change', () => {
  assert.match(css, /@keyframes\s+now-pulse\s*\{/, 'pulse keyframe defined');
  assert.match(css, /\.now-queue\.just-changed\s*\{[^}]*animation:[^;]*now-pulse[^;]*\s1\s*[;}]/, 'animation runs exactly one iteration');
  // app.js: the class is only added when the count actually changes…
  assert.match(appJs, /refreshStrip[\s\S]{0,900}just-changed/, 'refreshStrip wires the pulse');
  assert.match(appJs, /lastStripN\s*!==\s*n/, 'pulse fires on a real count change, not every tick');
  assert.match(appJs, /animationend/, 'class is removed on animationend (re-armable one-shot)');
  // …and nowhere else adds/removes it on a timer.
  assert.ok(!/setInterval\([^)]*just-changed/.test(appJs), 'no interval re-fires the pulse');
});

test('fe2 XSS: craft pass adds no innerHTML anywhere in app/ JS', () => {
  const files = [path.join(APP, 'app.js'),
    ...fs.readdirSync(path.join(APP, 'panels')).filter((f) => f.endsWith('.js')).map((f) => path.join(APP, 'panels', f))];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/\.innerHTML\s*[+]?=/.test(src), path.basename(f) + ' must never assign innerHTML');
  }
});

test('fe2 sanity: .hub-row selector targets a real emitted class', () => {
  const hubJs = fs.readFileSync(path.join(APP, 'panels', 'hub.js'), 'utf8');
  assert.match(hubJs, /'hub-row'/, 'hub.js emits .hub-row rows');
});
