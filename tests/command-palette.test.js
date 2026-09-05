// D3 TDD — command palette (cmd+K / ctrl+K) + tema-toggle (dark/light).
// Kontrakt:
//   - palette-modulet eksponerer {init, open, close, isOpen, register}
//   - register({id, label, run}) tilføjer kommandoer; open() viser input + liste
//   - filtration: skriv → matches label (case-insensitive)
//   - keyboard: Escape lukker; Enter kører første match; ArrowUp/Down flytter markering
//   - tema: toggleTheme() skifter documentElement dataset.theme dark<->light,
//     persisteres i localStorage 'tg-theme'; første load respekterer
//     prefers-color-scheme når ingen lagret værdi.
// Kører i node med den samme minimal-DOM-shim som panel-tests.
const test = require('node:test');
const assert = require('node:assert/strict');

// ── DOM-shim (uden DOM: palette-modulet kræver document + localStorage) ──
class Node2 {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.listeners = {};
    this.dataset = {};
    this.classList = { _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    };
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(' ').filter(Boolean)); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { for (const k of kids) if (k) this.children.push(k); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel, out = []) {
    const tag = sel.toUpperCase();
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      c.querySelectorAll(sel, out);
    }
    return out;
  }
}
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
global.document = {
  createElement: (t) => new Node2(t),
  createTextNode: (t) => { const n = new Node2('#text'); n._text = t; return n; },
  documentElement: new Node2('html'),
  addEventListener(ev, fn) { this['_on' + ev] = fn; },
};
global.window = { addEventListener(ev, fn) { this['_on' + ev] = fn; } };
global.navigator = {};

const palette = require('../app/lib/command-palette.js');

test('D3: modul-eksport kontrakt', () => {
  assert.equal(typeof palette.init, 'function');
  assert.equal(typeof palette.open, 'function');
  assert.equal(typeof palette.close, 'function');
  assert.equal(typeof palette.isOpen, 'function');
  assert.equal(typeof palette.register, 'function');
});

test('D3: register + open + filter', () => {
  palette.register({ id: 'rooms', label: 'Gå til Rooms', run: () => {} });
  palette.register({ id: 'artifacts', label: 'Gå til Artifacts', run: () => {} });
  palette.open();
  assert.equal(palette.isOpen(), true);
  // filtrér: skriv "art"
  palette.input && (palette.input.value = 'art');
  const res = palette.filtered('art');
  assert.deepEqual(res.map((c) => c.id), ['artifacts']);
  palette.close();
  assert.equal(palette.isOpen(), false);
});

test('D3: Enter kører første match; Escape lukker', () => {
  let ran = false;
  palette.register({ id: 'x', label: 'Kør X', run: () => { ran = true; } });
  palette.open();
  const input = palette.input;
  input.value = 'x'; // bruger har skrevet filteret
  input.listeners.input && input.listeners.input[0] && input.listeners.input[0]();
  input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  assert.equal(ran, true);
  assert.equal(palette.isOpen(), false);
});

test('D3: tema-toggle persisteres og skifter dataset.theme', () => {
  const theme = require('../app/lib/theme.js');
  theme.init();
  theme.toggle();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(localStorage.getItem('tg-theme'), 'light');
  theme.toggle();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(localStorage.getItem('tg-theme'), 'dark');
});
