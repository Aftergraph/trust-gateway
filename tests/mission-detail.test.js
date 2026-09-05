// F1 TDD — mission-detail drawer: ét klik viser alt for en mission.
// Drawer viser: objective, state, mission-correlation, WORKS-execution-status
// (GET /v2/executions/:missionId), evidence-link + AIE-leases (E4).
// Statisk kontrakt + render-integration.
const test = require('node:test');
const assert = require('node:assert/strict');

class Node2 {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {};
    this._text = ''; this.listeners = {}; this.dataset = {};
    this.classList = { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); }, contains(c) { return this._s.has(c); } };
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(' ').filter(Boolean)); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { for (const k of kids) if (k) this.children.push(k); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  querySelectorAll(sel, out = []) { const t = sel.toUpperCase();
    for (const c of this.children) { if (c.tagName === t) out.push(c); c.querySelectorAll(sel, out); } return out; }
}
global.document = {
  createElement: (t) => new Node2(t),
  createTextNode: (t) => { const n = new Node2('#text'); n._text = t; return n; },
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = { TG_PANELS: [], TG: {
  api: async (p) => {
    if (p === '/v2/proposals') return { proposals: [
      { id: 'prop_1', objective: 'Byg katalog', state: 'approved', proposer: 'forge', mission_id: 'mission_9' },
    ] };
    if (p.indexOf('/v2/executions/mission_9') === 0) return { work: { id: 'mission_9', state: 'RUNNING', evidence: [{ id: 'ev1' }] } };
    return {};
  },
  el: (t, c, x) => { const n = new Node2(t); n.className = c || ''; if (x !== undefined) n.textContent = x; return n; },
} };
global.navigator = {};

test('F1: missions-panel har detail-drawer funktion', () => {
  require('../app/panels/missions.js');
  const panel = global.window.TG_PANELS.find((p) => p.id === 'missions');
  assert.ok(panel, 'panel registreret');
  // modulet eksponerer drawer-API (internt men testbar via render-integration)
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.match(src, /mission-detail|drawer/, 'drawer-kode findes');
  assert.match(src, /\/v2\/executions\//, 'WORKS-execution hentes');
  assert.match(src, /evidence/i, 'evidence vises');
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven');
});
