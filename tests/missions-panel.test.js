// E3 TDD — missions-panel: liste /v2/proposals med status + godkend-flow.
// Statisk kontrakt (panel-registrering, endpoints, XSS-loven) + render-shim.
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
};
global.window = { TG_PANELS: [], TG: {
  api: async (p, opts) => {
    if (p === '/v2/proposals') return { proposals: [
      { id: 'prop_1', objective: 'Byg katalog', state: 'submitted', proposer: 'forge' },
      { id: 'prop_2', objective: 'Ryd tmp', state: 'approved', proposer: 'forge', mission_id: 'mission_9' },
    ] };
    return {};
  },
  el: (t, c, x) => { const n = new Node2(t); n.className = c || ''; if (x !== undefined) n.textContent = x; return n; },
} };
global.navigator = {};

test('E3: missions-panel registreret i TG_PANELS', () => {
  require('../app/panels/missions.js');
  const panel = global.window.TG_PANELS.find((p) => p.id === 'missions');
  assert.ok(panel, 'panel registreret');
  assert.equal(panel.title, 'Missions');
  assert.equal(typeof panel.render, 'function');
});

test('E3: render lister proposals med status + mission-correlation', async () => {
  const panel = global.window.TG_PANELS.find((p) => p.id === 'missions');
  const host = new Node2('div');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  const rows = host.querySelectorAll('div').filter((d) => String(d.className).includes('mission-row'));
  assert.equal(rows.length, 2, '2 proposals vist');
  assert.match(host.textContent, /mission_9/, 'mission-correlation vist');
});

test('E3: XSS-loven — ingen innerHTML', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.ok(!/innerHTML\s*=/.test(src), 'no innerHTML assignment');
});

test('E3: godkend-knap for submitted proposals (operator-flow)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');
  assert.match(src, /approve/, 'approve-knap');
  assert.match(src, /\/v2\/proposals\/[^\s]*\/submit|\/submit/, 'submit-kald');
});
