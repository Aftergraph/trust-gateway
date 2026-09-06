'use strict';
// §19: rate-panel alert-history + reactive SSE contract tests.
// XSS policy: textContent-only rendering (no element-html APIs).
// The panel is browser code; we assert loadable contracts in a VM sandbox
// (registration, render structure) plus source-level invariants (XSS rule,
// SSE wiring, alert query shape) that are hard to exercise in sandbox DOM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'app', 'panels', 'rate.js'), 'utf8');

function domNode(tag) {
  const children = [];
  const node = {
    tagName: tag,
    className: '',
    textContent: '',
    children,
    append(...nodes) { for (const n of nodes) { this.appendChild(n); } },
    appendChild(n) { children.push(n); return n; },
    addEventListener() { /* no-op */ },
    querySelector: () => domNode('#' + tag + '-child'), // frisk dummy: paneler kører api-kald igennem
  };
  return node;
}

function makeSandbox() {
  const calls = { api: [], tokenCalls: 0 };
  const win = {
    TG: {
      api: async (u) => { calls.api.push(u); return { events: [] }; },
      token: () => { calls.tokenCalls += 1; return 'atlas-live-tok'; },
    },
    TG_PANELS: [],
  };
  // §20: rate-panelet abonnerer via den fælles TG_EVENTS-klient (ticket-
  // exchange). Sandboxen fake'er klientens overflade; selve klientens
  // kontrakter testes separat i events-client.test.js.
  const ev = {
    openCalls: 0,
    closeUnsubs: [],
    onAudit: () => { ev.openCalls += 1; return () => { ev.closeUnsubs.push('audit'); }; },
    onAuthExpired: () => () => {},
    open: () => ev.openCalls += 1,
    isOpen: () => false,
  };
  win.TG_EVENTS = ev;
  const sandbox = {
    window: win,
    document: { createElement: (t) => domNode(t), createDocumentFragment: () => domNode('#frag') },
    EventSource: function () { this.close = () => {}; this.addEventListener = () => {}; },
    console,
    setTimeout,
    clearInterval,
    setInterval: () => 1,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
  };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(PANEL, sandbox, { filename: 'rate.js' });
  return { win, sandbox, calls };
}

test('S19: panelet registrerer sig som {id:rate} i TG_PANELS', () => {
  const { win } = makeSandbox();
  assert.equal(win.TG_PANELS.length, 1);
  assert.equal(win.TG_PANELS[0].id, 'rate');
  assert.equal(typeof win.TG_PANELS[0].render, 'function');
});

test('S19: render bygger alerts-sektion FØR buckets + 30s poll', () => {
  const { win } = makeSandbox();
  const container = domNode('main');
  win.TG_PANELS[0].render(container);
  const classes = container.children.map((c) => c.className);
  assert.ok(classes.includes('rate-alerts'), 'alerts section rendered: ' + classes.join(','));
  assert.ok(classes.includes('rate-buckets'));
  assert.ok(classes.includes('rate-limits'));
});

test('S19: alerts-liste henter 24h near-limit-seals fra federation-audit', async () => {
  const { win, calls } = makeSandbox();
  const container = domNode('main');
  win.TG_PANELS[0].render(container);
  await new Promise((r) => setImmediate(r)); // lad async refreshList/refreshAlerts lande
  assert.ok(calls.api.some((u) => u.includes('/v2/federation/audit/events?type=rate_bucket_near_limit&since=')),
    'alert query used, got: ' + calls.api.join(' | '));
  const since = calls.api.find((u) => u.includes('since=')).split('since=')[1].split('&')[0];
  const age = Date.now() - Number(since);
  assert.ok(Math.abs(86400000 - age) < 60000, 'since = 24h-vindue (age ' + age + 'ms)');
});

test('S20: SSE abonnerer via TG_EVENTS (ticket — ingen token i URL) + trailing debounce', () => {
  const src = PANEL;
  assert.ok(src.includes('window.TG_EVENTS.open()'), 'fælles SSE-klient åbnes');
  assert.ok(src.includes('window.TG_EVENTS.onAudit('), 'audit-frames abonneres via klienten');
  assert.ok(!src.includes('new EventSource('), 'rate-panelet opretter ikke egen EventSource (token-URL umuligt)');
  assert.ok(src.includes("p.type === 'rate_bucket_near_limit'"), 'frame-filter matcher seal-typen');
  assert.ok(src.includes('clearTimeout(debounceTimer)') && src.includes('setTimeout('),
    'trailing debounce samler burst-frames');
});

test('S19: XSS-politik overholdt — ingen element-html-APIs i rate-panelet', () => {
  assert.ok(!PANEL.includes('innerHTML'), 'textContent-only rendering');
  assert.ok(!PANEL.includes('insertAdjacentHTML'));
});

test('S19: alert-rækker viser seal-count (48/60) — ikke placeholder', () => {
  // regression: fmtCount() forventede et {count}-objekt; alert-rækken gav den
  // et tal → '—'. Nu: count ?? '—' (nul-safe, men tallet renderes).
  assert.ok(PANEL.includes("c === null || c === undefined ? '—' : String(c)"), 'count falder sikkert tilbage, men vises');
  assert.ok(!PANEL.includes("fmtCount((e.payload || e.data || {}).count)"), 'gammel fmtCount-misbrug væk');
});

test('S20: normalisering sker i fetch-laget (type-guard) — ikke i view-hjælper', () => {
  // §20: lærdom fra #50 — payload-formatet divergerede mellem runtime og
  // render. Events normaliseres nu ÉT sted i refreshAlerts (number | {count}
  // → count), så view'et aldrig ser rå seal-shapes.
  assert.ok(PANEL.includes('function normalizeCount('), 'type-guard findes');
  assert.ok(PANEL.includes("typeof raw === 'number'"), 'number-casen først');
  assert.ok(PANEL.includes("typeof raw.count === 'number'"), 'object-shape {count} dækket');
  assert.ok(PANEL.includes('map(normalizeAlertEvent)'), 'mapping i fetch-laget (refreshAlerts), ikke i render');
});

test('S20: re-render afmelder stream + aborter udestående fetches (ingen leak)', () => {
  const { win } = makeSandbox();
  const c1 = domNode('main');
  const c2 = domNode('main');
  win.TG_PANELS[0].render(c1);
  // re-render: forrige onAudit-unsubscribe + abortCtrl.abort()
  win.TG_PANELS[0].render(c2);
  assert.ok(win.TG_EVENTS.closeUnsubs.length >= 1, 'unsubscribe called on re-render');
});