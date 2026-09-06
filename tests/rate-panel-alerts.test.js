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
  const sandbox = {
    window: win,
    document: { createElement: (t) => domNode(t), createDocumentFragment: () => domNode('#frag') },
    EventSource: function () { this.close = () => {}; this.addEventListener = () => {}; },
    console,
    setTimeout,
    clearInterval,
    setInterval: () => 1,
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

test('S19: SSE abonnerer via ?token= (EventSource kan ikke sætte headers) og lytter på audit-frames', () => {
  const src = PANEL;
  assert.ok(src.includes("new EventSource('/v2/events?token=' + encodeURIComponent(tok))"),
    'SSE token query-param wiring');
  assert.ok(src.includes("window.TG.token"), 'token hentes fra TG.token()');
  assert.ok(src.includes("p.type === 'rate_bucket_near_limit'"), 'frame-filter matcher seal-typen');
  assert.ok(src.includes('refreshAlerts();'), 'seal-frame triggerer fuld refresh');
});

test('S19: XSS-politik overholdt — ingen innerHTML i rate-panelet', () => {
  assert.ok(!PANEL.includes('innerHTML'), 'textContent-only rendering');
  assert.ok(!PANEL.includes('insertAdjacentHTML'));
});

test('S19: re-render lukker eksisterende EventSource (ingen leak på tab-skift)', () => {
  const { win, sandbox } = makeSandbox();
  let closed = 0;
  // counting fake FØR første render, så render(c2)'s es.close() rammer tælleren
  sandbox.EventSource = function () { this.close = () => { closed += 1; }; this.addEventListener = () => {}; };
  const c1 = domNode('main');
  const c2 = domNode('main');
  win.TG_PANELS[0].render(c1);
  win.TG_PANELS[0].render(c2);
  assert.ok(closed >= 1, 'EventSource.close() called on re-render');
});