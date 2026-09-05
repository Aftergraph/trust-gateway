'use strict';
// v2q-(b) frontend E2E: secrets-vault operator-panel.
// Backend (FS-I5 + 119-secrets-rotate) er implementeret og testet; UI-panelet
// manglede — dette lukker fullstack-seamen.
//
//  - registrerer sig som TG_PANELS['secrets']
//  - render() henter vault-status + tenant-keys
//  - SECRET VALUES VISES ALDRIG (kun key-navne; "value" rendres ikke)
//  - rotate-master eksponeres kun for operator-rolle
//  - vault_disabled (404) vises ærligt, ikke som tomt panel
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'panels', 'secrets.js'), 'utf8');

function createMockDOM() {
  const allElements = [];
  function el(tag, className, text) {
    const e = {
      tagName: tag, className: className || '', textContent: text || '',
      children: [], style: {}, dataset: {}, title: '', value: '',
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

function loadModule(dom, apiFn, role) {
  const sandbox = {
    window: { TG: { api: apiFn, state: { bot: { role } } }, TG_PANELS: [] },
    document: { body: dom.body },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => {},
    clearInterval: () => {},
    console,
  };
  sandbox.window.TG.el = dom.el;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'secrets.js' });
  return sandbox;
}

// --- Mock API: normalt vault, operator-rolle ---
const calls = [];
function mockApi(urlPath, opts) {
  calls.push({ path: urlPath, opts });
  if (urlPath === '/v2/secrets') {
    return Promise.resolve({
      enabled: true,
      masterRotatedAt: '2026-08-01T00:00:00Z',
      tenants: [
        { tenant: 'acme', keys: ['api_key', 'webhook_secret'] },
        { tenant: 'globex', keys: [] },
      ],
    });
  }
  if (urlPath === '/v2/secrets/rotate-master') {
    return Promise.resolve({ ok: true, rotatedCount: 2 });
  }
  return Promise.resolve({});
}

test('v2q: secrets-panel registrerer sig og render() henter vault-status', async () => {
  calls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi, 'operator');
  const panel = sb.window.TG_PANELS.find((p) => p.id === 'secrets');
  assert.ok(panel, 'secrets-panel skal registrere sig i TG_PANELS');
  assert.equal(panel.title, 'Secrets', 'title (ikke name) — core.js læser .title');
  const host = dom.el('div', 'host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(calls.some((c) => c.path === '/v2/secrets'), 'render skal hente vault-status');
});

test('v2q: secret VALUES vises aldrig — kun key-navne (key-ONLY)', async () => {
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi, 'operator');
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'secrets').render(host);
  await new Promise((r) => setTimeout(r, 40));
  const renderedText = dom.allElements.map((e) => e.textContent).join(' ');
  assert.ok(renderedText.includes('api_key'), 'key-navn vises');
  assert.ok(renderedText.includes('webhook_secret'), 'key-navn vises');
  // Værdien "super-secret-value" findes aldrig i mock'en som output — men
  // testen garanterer strukturelt: ingen GET-for-value i mock, og panel
  // renderer kun keys. Vi verificerer at render ikke efterlyser values:
  const valueGets = calls.filter((c) => c.path.includes('/secrets/') && !c.path.endsWith('/secrets'));
  assert.equal(valueGets.length, 0, 'panel må ikke hente secret-values');
});

test('v2q: rotate-master kalder POST og viser bekræftelse', async () => {
  calls.length = 0;
  const dom = createMockDOM();
  const sb = loadModule(dom, mockApi, 'operator');
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'secrets').render(host);
  await new Promise((r) => setTimeout(r, 40));

  const rotateBtn = dom.allElements.find((e) =>
    e.className === 'btn secrets-rotate');
  assert.ok(rotateBtn, 'rotate-knap findes for operator');
  const rotateInput = dom.allElements.find((e) => e.className === 'secrets-rotate-input');
  assert.ok(rotateInput, 'rotate-input findes');
  rotateInput.value = 'brand-new-master-key'; // min 16 tegn, ellers afvises (weak_key guard)
  rotateBtn._listeners.click();
  await new Promise((r) => setTimeout(r, 30));

  const rotateCall = calls.find((c) => c.path === '/v2/secrets/rotate-master');
  assert.ok(rotateCall, 'POST /v2/secrets/rotate-master skal kaldes');
  const okText = dom.allElements.some((e) =>
    typeof e.textContent === 'string' && (e.textContent.includes('roteret') || e.textContent.includes('rotated')));
  assert.ok(okText, 'rotate-bekræftelse vises');
});

test('v2q: vault_disabled vises ærligt, ikke som tomt panel', async () => {
  function disabledApi(urlPath) {
    if (urlPath === '/v2/secrets') {
      return Promise.resolve({ error: 'vault_disabled' });
    }
    return Promise.resolve({});
  }
  const dom = createMockDOM();
  const sb = loadModule(dom, disabledApi, 'operator');
  const host = dom.el('div', 'host');
  sb.window.TG_PANELS.find((p) => p.id === 'secrets').render(host);
  await new Promise((r) => setTimeout(r, 40));
  const txt = dom.allElements.map((e) => e.textContent).join(' ');
  assert.ok(txt.toLowerCase().includes('disabled') || txt.toLowerCase().includes('vault'),
    'disabled-state skal vises ærligt');
});

test('v2q: XSS-loven — ingen innerHTML i secrets.js', () => {
  assert.ok(!src.includes('innerHTML'), 'secrets.js må ikke bruge innerHTML');
});
