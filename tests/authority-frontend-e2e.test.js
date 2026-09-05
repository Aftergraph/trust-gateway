'use strict';
// H4-H6 E2E frontend: loader authority.js i mock-DOM, kalder render(),
// verificerer rigtig adfærd (ikke kun source-strings).
// Minimal DOM-mock: Node ingen jsdom, men vi simulerer nok til at
// modulet kan registrere, kalde TG.api(), og vise reel UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'authority.js'), 'utf8');

// --- Mock TG.api ---
const apiCalls = [];
function mockApi(urlPath, opts) {
  apiCalls.push({ path: urlPath, opts });
  if (urlPath === '/v2/authority') {
    return Promise.resolve({ counts: { leases: 2, missions: 1, admissions: 0, outcomes: 0, evidence: 0 } });
  }
  if (urlPath === '/v2/authority/leases') {
    return Promise.resolve({
      items: [
        { id: 'lease_1', revoked: false, depth: 0, budget_remaining: 80, budget_total: 100,
          revocation_history: [], parent_lease_id: null, child_leases: [] },
        { id: 'lease_revoked', revoked: true, depth: 1, budget_remaining: 0, budget_total: 50,
          revocation_history: [{ reason: 'expired', revoked_at: '2026-09-01', actor: 'admin' }],
          parent_lease_id: 'lease_1', child_leases: [] },
      ],
      count: 2,
    });
  }
  if (urlPath === '/v2/authority/missions') {
    return Promise.resolve({
      items: [{ id: 'mission_1', state: 'active', transitions: [], linked_leases: [] }],
      count: 1,
    });
  }
  if (opts && opts.method === 'POST' && /\/revoke$/.test(urlPath)) {
    return Promise.resolve({ ok: true, lease_id: 'lease_1', revoked: true });
  }
  return Promise.resolve({ items: [], count: 0 });
}

// --- Minimal DOM-mock med parent/child tracking ---
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
          if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
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

// --- Indlæs modul i sandbox ---
function loadModule(dom, apiFn, promptFn) {
  const sandbox = {
    window: { TG: { api: apiFn }, TG_PANELS: [] },
    document: { body: dom.body },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => {},
    clearInterval: () => {},
    prompt: promptFn || (() => 'test-reason'),
    console,
  };
  sandbox.window.TG.el = dom.el;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'authority.js' });
  return sandbox;
}

// --- Tests ---

test('H4: modul registrerer sig i TG_PANELS med korrekt id', () => {
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  assert.equal(sb.window.TG_PANELS.length, 1);
  assert.equal(sb.window.TG_PANELS[0].id, 'authority');
  assert.equal(typeof sb.window.TG_PANELS[0].render, 'function');
});

test('H4: render() kalder /v2/authority og /v2/authority/leases', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  const paths = apiCalls.map((c) => c.path);
  assert.ok(paths.includes('/v2/authority'), 'henter counts');
  assert.ok(paths.includes('/v2/authority/leases'), 'henter leases (default kind)');
});

test('H5: item-række har click-handler', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  const rows = dom.allElements.filter((e) => e.className === 'auth-row');
  assert.ok(rows.length >= 1, 'auth-row er oprettet');
  assert.ok(rows[0]._listeners.click, 'click-handler på row');
});

test('H5: click på revoked lease-row åbner detail-drawer med revocation-historik', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  // Find den revoked row (har "REVOKED" badge)
  const rows = dom.allElements.filter((e) => e.className === 'auth-row');
  const revokedRow = rows.find((r) => r.children.some((c) => c.textContent === 'REVOKED'));
  assert.ok(revokedRow, 'revoked lease row findes');

  // Kald click — showDetail åbner drawer i list.parentElement
  revokedRow._listeners.click();

  // Find auth-detail-drawer
  const drawer = dom.allElements.find((e) => e.className === 'auth-detail-drawer');
  assert.ok(drawer, 'detail-drawer oprettet efter click');
  // Drawer skal indeholde revocation-historik
  const hasRevInfo = drawer.children.some((c) =>
    (c.textContent || '').includes('expired') || (c.textContent || '').includes('Revocation'));
  assert.ok(hasRevInfo, 'revocation-historik i drawer');
});

test('H6: revoke-knappen vises i ACTIVE lease drawer (ikke for revoked)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi);
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  // Click ACTIVE lease row (lease_1, revoked=false)
  const rows = dom.allElements.filter((e) => e.className === 'auth-row');
  const activeRow = rows.find((r) => r.children.some((c) => c.textContent === 'ACTIVE'));
  assert.ok(activeRow, 'ACTIVE lease row findes');
  activeRow._listeners.click();

  // Drawer med revoke-knap
  const revokeBtn = dom.allElements.find((e) => e.className.includes('auth-revoke-btn'));
  assert.ok(revokeBtn, 'revoke-knap i ACTIVE lease drawer');

  // Click revoke — kalder api med POST
  apiCalls.length = 0;
  revokeBtn._listeners.click();
  await new Promise((r) => setTimeout(r, 10));

  const postCalls = apiCalls.filter((c) => c.opts && c.opts.method === 'POST' && /\/revoke/.test(c.path));
  assert.ok(postCalls.length >= 1, 'POST /revoke kaldt');
});

test('H6: revoke-med-tom-reason afslår (prompt cancel)', async () => {
  apiCalls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi, () => '');  // prompt returnerer tom
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS[0].render(host);
  await new Promise((r) => setTimeout(r, 30));

  // Click ACTIVE lease → drawer
  const rows = dom.allElements.filter((e) => e.className === 'auth-row');
  const activeRow = rows.find((r) => r.children.some((c) => c.textContent === 'ACTIVE'));
  activeRow._listeners.click();

  const revokeBtn = dom.allElements.find((e) => e.className.includes('auth-revoke-btn'));
  assert.ok(revokeBtn, 'revoke-knap findes');

  apiCalls.length = 0;
  revokeBtn._listeners.click();

  // Ingen POST revoke med tom reason
  const postCalls = apiCalls.filter((c) => c.opts && c.opts.method === 'POST' && /\/revoke/.test(c.path));
  assert.equal(postCalls.length, 0, 'ingen POST revoke med tom reason');
  // Status-melding om cancel
  const cancelMsg = dom.allElements.find((e) =>
    typeof e.textContent === 'string' && e.textContent.includes('revoke cancelled'));
  assert.ok(cancelMsg, 'cancel melding vises');
});

test('XSS-loven: ingen innerHTML i authority.js', () => {
  assert.ok(!/innerHTML\s*=/.test(src), 'XSS-loven: ingen innerHTML');
});
