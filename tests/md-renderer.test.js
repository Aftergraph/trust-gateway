// A3 TDD — letvægts markdown-renderer (0 deps, DOM/textContent-only, XSS-loven).
// Kører i node med en minimal DOM-shim (samme konvention som panel-tests).
const test = require('node:test');
const assert = require('node:assert/strict');

// ── minimal DOM shim ─────────────────────────────────────────────────
class Node2 {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.listeners = {};
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  append(...kids) { for (const k of kids) if (k) this.children.push(k); }
  appendChild(k) { this.children.push(k); return k; }
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
global.document = {
  createElement: (tag) => new Node2(tag),
  createTextNode: (text) => { const n = new Node2('#text'); n.textContent = text; return n; },
};

const { render } = require('../app/lib/md.js');

test('md: modul eksporterer render', () => {
  assert.equal(typeof render, 'function');
});

test('md: overskrift + afsnit struktur', () => {
  const frag = render('# Titel\n\nBrødtekst.');
  assert.equal(frag.children.length, 2);
  assert.equal(frag.children[0].tagName, 'H1');
  assert.equal(frag.children[0].textContent, 'Titel');
  assert.equal(frag.children[1].tagName, 'P');
  assert.equal(frag.children[1].textContent, 'Brødtekst.');
});

test('md: kodeblok med sprog + copy-knap', () => {
  const frag = render('```js\nconst x = 1;\n```');
  const pre = frag.querySelector('pre');
  assert.ok(pre, 'pre present');
  assert.equal(pre.getAttribute('data-lang'), 'js');
  assert.match(pre.textContent, /const x = 1;/);
  const btn = frag.querySelector('button');
  assert.ok(btn, 'copy button present');
});

test('md: inline formatting — bold/italic/code', () => {
  const frag = render('**fedt** og *kursiv* og `kode`');
  const p = frag.querySelector('p');
  const strong = p.querySelectorAll('strong');
  const em = p.querySelectorAll('em');
  const code = p.querySelectorAll('code');
  assert.equal(strong.length, 1); assert.equal(strong[0].textContent, 'fedt');
  assert.equal(em.length, 1); assert.equal(em[0].textContent, 'kursiv');
  assert.equal(code.length, 1); assert.equal(code[0].textContent, 'kode');
});

test('md: lister (uordnede + ordnede)', () => {
  const frag = render('- a\n- b\n\n1. x\n2. y');
  assert.equal(frag.querySelectorAll('ul').length, 1);
  assert.equal(frag.querySelectorAll('ol').length, 1);
  assert.equal(frag.querySelectorAll('li').length, 4);
});

test('md: tabel', () => {
  const frag = render('| a | b |\n|---|---|\n| 1 | 2 |');
  const table = frag.querySelector('table');
  assert.ok(table, 'table present');
  assert.equal(table.querySelectorAll('th').length, 2);
  assert.equal(table.querySelectorAll('td').length, 2);
});

test('md: links — kun http(s), target=_blank, javascript: droppes', () => {
  const frag = render('[docs](https://example.com) og [ond](javascript:alert(1))');
  const links = frag.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.com');
  assert.equal(links[0].getAttribute('target'), '_blank');
  assert.equal(links[0].getAttribute('rel'), 'noopener');
});

test('md: XSS — html-tekst forbliver ren tekst', () => {
  const frag = render('<img src=x onerror=alert(1)>hej');
  assert.equal(frag.querySelectorAll('img').length, 0);
  assert.match(frag.textContent, /<img src=x onerror=alert\(1\)>hej/);
});
