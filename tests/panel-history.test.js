'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PANEL = path.join(__dirname, '..', 'app', 'panels', 'history.js');
const APP = path.join(__dirname, '..', 'app');
const src = fs.readFileSync(PANEL, 'utf8');

test('history.js is syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'history.js' }), 'history.js must parse');
});

test('history.js registers itself in TG_PANELS', () => {
  assert.match(src, /TG_PANELS\s*=\s*window\.TG_PANELS\s*\|\|\s*\[\]/, 'defensive TG_PANELS init');
  assert.match(src, /\.push\(\s*\{[^}]*id:\s*'history'/, 'pushes a history panel descriptor');
});

test('XSS policy: no innerHTML assignment in history.js', () => {
  assert.ok(!/\.innerHTML\s*[+]?=/.test(src), 'history.js must never assign innerHTML');
});

test('history search wiring (mock TG): /v2/search used when query present', async () => {
  const calls = [];
  const fakeTG = {
    api: (p) => { calls.push(p); return Promise.resolve(p.startsWith('/v1/audit') ? { entries: [] } : { hits: [] }); },
    el: (t, c, x) => ({ tagName: t, className: c, textContent: x }),
  };

  // Build a minimal DOM + window mock implementing enough of the DOM surface.
  const nodes = [];
  const makeNode = (tag) => ({
    tagName: tag, className: '', id: '', textContent: '', value: '',
    style: {}, dataset: {},
    _children: [], _parent: null, _listeners: {},
    appendChild(c) { this._children.push(c); c._parent = this; return c; },
    insertBefore(c, ref) { this._children.push(c); c._parent = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); return this; },
    prepend(...cs) { this._children.unshift(...cs); return this; },
    firstChild: { textContent: '' },
    querySelectorAll(sel) { return this._children; },
    querySelector(sel) { return this._children[0]; },
    addEventListener(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).concat(fn); },
    cloneNode() { return makeNode(tag); },
  });
  const createElement = (tag) => { const n = makeNode(tag); nodes.push(n); return n; };
  const getElementById = (id) => nodes.find((n) => n.id === id) || null;
  const body = makeNode('body');

  const sandbox = {
    window: {
      document: {
        readyState: 'complete',
        addEventListener() {},
        getElementById,
        createElement,
        createDocumentFragment: () => ({ appendChild() {}, insertBefore() {} }),
        body,
      },
      TG: fakeTG,
      TG_PANELS: [],
      setTimeout: () => 0,
    },
    console,
  };
  // Expose document as a bare global (browser scripts use it directly).
  sandbox.document = sandbox.window.document;
  vm.createContext(sandbox);
  // Provide a TG global for the script.
  sandbox.window.TG = fakeTG;
  vm.runInContext(src, sandbox);

  assert.equal(sandbox.window.TG_PANELS.length, 1, 'history registered exactly once');
  assert.equal(sandbox.window.TG_PANELS[0].id, 'history');
  assert.equal(typeof sandbox.window.TG_PANELS[0].render, 'function');

  // Render the panel.
  const host = makeNode('section');
  sandbox.window.TG_PANELS[0].render(host);

  // Trigger a search: call api should hit /v1/audit on initial load.
  assert.ok(calls.some((p) => /\/v1\/audit/.test(p)), 'initial load hits /v1/audit');

  // Now set a query and refresh → must hit /v2/search.
  calls.length = 0;
  sandbox.window.TG_HISTORY.setFilters('all', '');
  // Inject a query by stubbing the searchInput value via re-render path.
  // The panel reads searchInput.value.trim(); set it before refresh by
  // capturing the input node created during render.
  const inputs = [];
  const origCreate = sandbox.window.document.createElement;
  sandbox.window.document.createElement = (tag) => { const n = origCreate(tag); if (tag === 'input') inputs.push(n); return n; };
  // searchInput is the first input created in render; set its value.
  host; // keep host alive
  // Re-render to get a fresh searchInput we can drive.
  const host2 = makeNode('section');
  sandbox.window.TG_PANELS[0].render(host2);
  const srch = inputs.find((i) => i.className === 'hist-search');
  assert.ok(srch, 'search input created');
  srch.value = 'login';
  // Drive refresh via the input's registered listener (input event).
  const listeners = srch._listeners['input'] || [];
  listeners.forEach((fn) => fn({ target: srch }));
  // Allow promise microtasks.
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((p) => /\/v2\/search/.test(p)), 'non-empty query routes to /v2/search?q=' + calls.join(','));
});

test('live HTTP: /panels/core.js and /panels/history.js serve 200 from Gateway({staticDir})', async () => {
  const http = require('node:http');
  const { Gateway } = require('../src/gateway/server');
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { authorization: 'Bearer tok-a' } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], body: b }));
      }).on('error', reject);
    });
    for (const f of ['/panels/core.js', '/panels/history.js']) {
      const r = await get(f);
      assert.equal(r.status, 200, f + ' serves 200');
      assert.match(r.ct, /javascript/, f + ' content-type');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('history type filter select exposes distinct payload.type values', () => {
  // Static contract: select populated from distinct payload.type values.
  assert.match(src, /hist-type/, 'type select class present');
  assert.match(src, /allOpt.value = 'all'|all types/, 'all-types option present');
  assert.match(src, /populateTypes/, 'distinct-type population implemented');
});

test('history bot filter text narrows rows by payload.bot prefix', () => {
  // Static contract: bot filter input wired to currentBot and matchesFilters.
  assert.match(src, /hist-bot/, 'bot filter input class present');
  assert.match(src, /currentBot && .*indexOf/, 'bot filter uses prefix match');
  assert.match(src, /setFilters/, 'filters are externally settable for tests');
});
