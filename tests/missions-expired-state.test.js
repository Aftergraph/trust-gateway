'use strict';
// H8 E2E frontend: expired proposals behandles som reel tilstand i missions-panelet.
//  - expired status vises som state-badge (mission-state-expired)
//  - approve/reject-knapper vises IKKE for expired (fail-closed: backend
//    afviser med 'cannot approve from status expired')
//  - detail-drawer viser 'status: expired'
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'missions.js'), 'utf8');

const apiCalls = [];
function mockApi(urlPath, opts) {
  apiCalls.push({ path: urlPath, opts });
  if (urlPath === '/v2/proposals') {
    return Promise.resolve({
      proposals: [
        { id: 'p_expired', state: 'expired', objective: 'old mission', expired_at: '2026-08-01T00:00:00Z' },
        { id: 'p_submitted', state: 'submitted', objective: 'active mission' },
      ],
    });
  }
  if (urlPath === '/v2/executions/p_expired/evidence') {
    return Promise.resolve({ evidence: [], evidence_verdicts: [] });
  }
  if (urlPath === '/v2/executions/p_submitted/evidence') {
    return Promise.resolve({ evidence: [], evidence_verdicts: [] });
  }
  return Promise.resolve({ proposals: [] });
}

function createMockDOM() {
  const allElements = [];
  function el(tag, className, text) {
    const e = {
      tagName: tag, className: className || '', textContent: text || '',
      children: [], style: {}, dataset: {}, title: '',
      parentElement: null, _listeners: {},
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); } },
      append(...ch) { for (const c of ch) { if (c) { c.parentElement = this; this.children.push(c); } } },
      addEventListener(ev, fn) { this._listeners[ev] = fn; },
      remove() { this._removed = true; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.startsWith('.') && cur.className === sel.slice(1)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
    };
    allElements.push(e);
    return e;
  }
  const body = el('body', '');
  body.contains = () => true;
  return { el, body, allElements };
}

function loadModule(dom, apiFn) {
  const sandbox = {
    window: { TG: { api: apiFn }, TG_PANELS: [] },
    document: { body: dom.body },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => {},
    clearInterval: () => {},
    console,
  };
  sandbox.window.TG.el = dom.el;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'missions.js' });
  return sandbox;
}

test('H8: expired proposal vises som expiration-row med state-badge (mission-state-expired)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'missions').render(host);
  await new Promise((r) => setTimeout(r, 40));

  const expiryRows = dom.allElements.filter((e) => e.className === 'mission-row' &&
    e.children.some((c) => c.className.includes('mission-state-expired')));
  assert.ok(expiryRows.length >= 1, 'expired proposal row med mission-state-expired badge');
});

test('H8: approve/reject-knapper vises IKKE for expired proposals (fail-closed)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'missions').render(host);
  await new Promise((r) => setTimeout(r, 40));

  // Find expired row
  const expiredRow = dom.allElements.find((e) => e.className === 'mission-row' &&
    e.children.some((c) => c.className.includes('mission-state-expired')));
  assert.ok(expiredRow, 'expired row findes');

  // Actions children skal ikke inkludere approve/reject-knapper
  const actionBtns = dom.allElements.filter((e) =>
    expiredRow.children.some((c) => c.children && c.children.includes(e)));
  const approveBtns = actionBtns.filter((e) => e.className && e.className.includes('approve'));
  const rejectBtns = actionBtns.filter((e) => e.className && e.className.includes('reject'));
  assert.equal(approveBtns.length, 0, 'ingen approve-knap for expired');
  assert.equal(rejectBtns.length, 0, 'ingen reject-knap for expired');
});

test('H8: detail-drawer for expired viser status expired (backend truth)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'missions').render(host);
  await new Promise((r) => setTimeout(r, 40));

  // Find detail-knap der hører til expired-row (via child-hierarki)
  const expiredRow = dom.allElements.find((e) => e.className === 'mission-row' &&
    e.children.some((c) => c.className.includes('mission-state-expired')));
  assert.ok(expiredRow, 'expired row findes');
  const isDescendant = (parentEl, target) =>
    parentEl.children.some((c) => c === target || isDescendant(c, target));
  const expiredDetailBtn = dom.allElements.find((e) =>
    e.className === 'btn mission-detail' && isDescendant(expiredRow, e));
  assert.ok(expiredDetailBtn, 'detail-knap til expired row findes');
  expiredDetailBtn._listeners.click();
  await new Promise((r) => setTimeout(r, 30));

  const statusLine = dom.allElements.find((e) =>
    typeof e.textContent === 'string' && e.textContent.includes('status: expired'));
  assert.ok(statusLine, 'drawer viser status: expired');
});