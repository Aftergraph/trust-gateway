'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// tests/panel-artifacts.test.js — wave B artifacts panel (follow-along UI).
// Covers: registration contract, XSS policy (textContent-only, no innerHTML),
// list/detail/version-selector behavior, artifact_updated live refetch,
// create form, and real HTTP against the W5 /v2/artifacts mount.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PANEL = path.join(__dirname, '..', 'app', 'panels', 'artifacts.js');

// ── minimal DOM shim (zero deps) ─────────────────────────────────────────
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    listeners: {},
    parentNode: null,
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    placeholder: '',
    append(...kids) {
      for (const k of kids) {
        if (k == null) continue;
        k.parentNode = node;
        node.children.push(k);
      }
    },
    appendChild(k) { if (k == null) return k; k.parentNode = node; node.children.push(k); return k; },
    removeChild(k) {
      const i = node.children.indexOf(k);
      if (i >= 0) node.children.splice(i, 1);
      return k;
    },
    addEventListener(t, fn) { (node.listeners[t] = node.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (node.listeners[t] || []).forEach((fn) => fn(ev)); },
    setAttribute(k, v) { node.attributes[k] = v; },
  };
  // minimal classList backed by className (space-separated)
  node.classList = {
    add(c) { const s = new Set(node.className.split(/\s+/).filter(Boolean)); s.add(c); node.className = [...s].join(' '); },
    remove(c) { const s = new Set(node.className.split(/\s+/).filter(Boolean)); s.delete(c); node.className = [...s].join(' '); },
    contains(c) { return node.className.split(/\s+/).filter(Boolean).includes(c); },
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { throw new Error('innerHTML read — XSS policy forbids it'); },
    set() { throw new Error('innerHTML assignment — XSS policy violation'); },
  });
  return node;
}
function fire(n, type, ev) { (n.listeners[type] || []).forEach((fn) => fn(ev || {})); }

// ── fake TG surface ──────────────────────────────────────────────────────
function fakeTG(store, { authed = true } = {}) {
  const auditListeners = [];
  return {
    api: async (p, opts = {}) => {
      const m = (opts.method || 'GET').toUpperCase();
      let mm = /^\/v2\/artifacts$/.exec(p);
      if (mm) {
        if (m === 'GET') return { artifacts: store.list() };
        if (m === 'POST') {
          const out = store.create(JSON.parse(opts.body));
          if (!out.ok) { const e = new Error(out.error); e.status = 400; throw e; }
          return { artifact: out.artifact };
        }
      }
      mm = /^\/v2\/artifacts\/([^/]+)$/.exec(p);
      if (mm && m === 'GET') {
        const a = store.get(decodeURIComponent(mm[1]));
        if (!a) { const e = new Error('nf'); e.status = 404; throw e; }
        return { artifact: a };
      }
      const e = new Error('no route'); e.status = 404; throw e;
    },
    el: (tag, cls, text) => {
      const n = makeNode(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    },
    token: () => 'tok',
    authed: () => authed,
    refresh: () => {},
    onAudit: (fn) => auditListeners.push(fn),
    _emit: (e) => auditListeners.forEach((f) => f(e)),
  };
}

// tiny in-memory artifact store mirroring W5 shapes
function makeStore() {
  const items = new Map();
  let n = 0;
  return {
    list: () => [...items.values()].map(({ versions, content, ...rest }) => rest),
    get: (id) => items.get(id) || null,
    create({ kind, title, content, bot }) {
      const id = 'art-' + (++n);
      const ts = Date.now() + n;
      const a = {
        id, kind, title, content, bot: bot ?? null, sessionRef: null,
        version: 1, createdAt: ts, updatedAt: ts,
        versions: [{ v: 1, ts, bot: bot ?? null, title, content, hash: 'h' + n }],
      };
      items.set(id, a);
      return { ok: true, artifact: a };
    },
    putVersion(id, { bot, content, title }) {
      const a = items.get(id);
      if (!a) return { ok: false, error: 'not_found' };
      const v = a.version + 1;
      const ts = Date.now() + v;
      const nv = { v, ts, bot, title: title ?? a.title, content: content ?? a.content, hash: 'h' + id + '.' + v };
      a.versions.push(nv);
      a.version = v;
      a.updatedAt = ts;
      if (content != null) a.content = content;
      if (title != null) a.title = title;
      return { ok: true, version: nv, artifact: a };
    },
  };
}

function renderPanel(tg) {
  const container = makeNode('div');
  const code = fs.readFileSync(PANEL, 'utf8');
  // new Function is safe here: the body is the panel's own committed source
  // file (not user-controlled input), and the injected `window` binding is
  // this test's shim — nothing untrusted is interpolated into the body.
  const fn = new Function('window', code + '\n;return window;');
  const fakeWindow = { TG_PANELS: [] };
  fn(fakeWindow);
  const panels = fakeWindow.TG_PANELS;
  assert.equal(panels.length, 1, 'panel registered itself');
  const node = panels[0].render(container, tg);
  assert.ok(node, 'render returns node');
  assert.equal(container.children.includes(node), true, 'render appended to container');
  return { node, container, panels };
}

const textOf = (n) => n.textContent;

// ── static contract ──────────────────────────────────────────────────────
test('panel file exists and is referenced by index.html', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/artifacts.js exists');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(html, /\/panels\/artifacts\.js/);
});

test('XSS: no innerHTML usage anywhere in the panel source', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'must never assign innerHTML');
  assert.ok(!/\.outerHTML\s*[+]?=/.test(js), 'must never assign outerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'must never use insertAdjacentHTML');
  assert.ok(js.includes('textContent'), 'uses textContent');
});

test('registers {id,title,render} on window.TG_PANELS', () => {
  const { panels } = renderPanel(fakeTG(makeStore()));
  assert.deepEqual(
    { id: panels[0].id, title: panels[0].title },
    { id: 'artifacts', title: 'Artifacts' }
  );
});

// ── behavior with fake TG ────────────────────────────────────────────────
test('list rows show kind tag, title, bot, version', async () => {
  const store = makeStore();
  store.create({ kind: 'code', title: 'fix.sh', content: 'echo hi', bot: 'worker-1' });
  store.create({ kind: 'report', title: 'Q3 summary', content: 'numbers', bot: 'analyst' });
  const tg = fakeTG(store);
  const { node } = renderPanel(tg);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const list = node.children.find((c) => c.className === 'art-list');
  assert.ok(list, 'list node exists');
  const rows = list.children.filter((c) => c.className.includes('art-row'));
  assert.equal(rows.length, 2);
  const texts = rows.map((r) => r.children.map(textOf).join('|'));
  assert.ok(texts[0].includes('code'), 'kind tag rendered: ' + texts[0]);
  assert.ok(texts[0].includes('fix.sh'), 'title rendered');
  assert.ok(texts[0].includes('worker-1'), 'bot rendered');
  assert.ok(texts[0].includes('v1'), 'version rendered');
  assert.ok(texts[1].includes('report') && texts[1].includes('Q3 summary') && texts[1].includes('analyst'));
});

test('detail pane: content into <pre> textContent, version selector lists history', async () => {
  const store = makeStore();
  const a = store.create({ kind: 'doc', title: 'notes', content: 'draft one', bot: 'b' });
  store.putVersion(a.artifact.id, { bot: 'b2', content: 'draft two', title: null });
  const tg = fakeTG(store);
  const { node } = renderPanel(tg);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const list = node.children.find((c) => c.className === 'art-list');
  const row = list.children.find((c) => c.className.includes('art-row'));
  row.dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const detail = node.children.find((c) => c.className === 'art-detail');
  assert.ok(detail, 'detail exists');
  const pre = detail.children.find((c) => c.tagName === 'PRE');
  const sel = detail.children.find((c) => c.tagName === 'SELECT');
  assert.ok(pre && sel, 'pre + version select exist');
  assert.equal(pre.textContent, 'draft two', 'latest version content in pre (textContent)');
  assert.equal(sel.children.length, 2, 'two versions in selector');
  // pick v1
  sel.value = '0';
  sel.dispatch('change');
  assert.equal(pre.textContent, 'draft one', 'version selector switches content');
});

test('live: artifact_updated audit for selected artifact refetches detail + list and highlights', async () => {
  const store = makeStore();
  const created = store.create({ kind: 'code', title: 'bot.js', content: 'v1 body', bot: 'w' });
  const id = created.artifact.id;
  const tg = fakeTG(store);
  const { node } = renderPanel(tg);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const list = node.children.find((c) => c.className === 'art-list');
  list.children.find((c) => c.className.includes('art-row')).dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // server-side update + audit event
  store.putVersion(id, { bot: 'w', content: 'v2 body — live!', title: null });
  tg._emit({ payload: { type: 'artifact_updated', artifactId: id, version: 2 } });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const detail = node.children.find((c) => c.className === 'art-detail');
  const pre = detail.children.find((c) => c.tagName === 'PRE');
  assert.equal(pre.textContent, 'v2 body — live!', 'refetched content after artifact_updated');
  const sel = detail.children.find((c) => c.tagName === 'SELECT');
  assert.equal(sel.children.length, 3, 'version history grew (v1, v2, v3)');
  assert.equal(pre.className.includes('art-live'), true, 'live highlight applied');

  // unrelated update must NOT refetch
  const other = store.create({ kind: 'doc', title: 'other', content: 'x', bot: 'w' });
  tg._emit({ payload: { type: 'artifact_updated', artifactId: other.artifact.id, version: 1 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(sel.children.length, 3, 'unrelated update left version history untouched');
  assert.equal(pre.textContent, 'v2 body — live!', 'unrelated update left detail untouched');
});

test('create form: kind select, title, content textarea → POST + list refresh', async () => {
  const store = makeStore();
  const tg = fakeTG(store);
  const { node } = renderPanel(tg);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const form = node.children.find((c) => c.className === 'art-new');
  assert.ok(form, 'create form exists');
  const kindSel = form.children.find((c) => c.tagName === 'SELECT');
  const kinds = kindSel.children.map((o) => o.textContent).sort();
  assert.deepEqual(kinds, ['code', 'doc', 'image-ref', 'report']);
  const title = form.children.find((c) => c.tagName === 'INPUT');
  const ta = form.children.find((c) => c.tagName === 'TEXTAREA');
  const btn = form.children.find((c) => c.tagName === 'BUTTON');

  title.value = 'made in panel';
  ta.value = 'hello <script>alert(1)</script>';
  kindSel.value = 'doc';
  btn.dispatch('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(store.list().length, 1, 'artifact created via API');
  const stored = store.get('art-1');
  assert.equal(stored.content, 'hello <script>alert(1)</script>', 'raw content stored (escaping is a render concern)');
  const detail = node.children.find((c) => c.className === 'art-detail');
  const pre = detail.children.find((c) => c.tagName === 'PRE');
  assert.equal(pre.textContent, 'hello <script>alert(1)</script>', 'content only ever lands via textContent');
  assert.equal(title.value, '', 'title cleared');
  assert.equal(ta.value, '', 'textarea cleared');

  // empty title → no POST
  btn.dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(store.list().length, 1, 'empty title rejected client-side');
});

test('unauthenticated: prompts to connect instead of fetching', async () => {
  const tg = fakeTG(makeStore(), { authed: false });
  const { node } = renderPanel(tg);
  await new Promise((r) => setImmediate(r));
  const list = node.children.find((c) => c.className === 'art-list');
  assert.ok(list.children.some((c) => c.textContent.includes('connect a token')));
});

// ── real HTTP against the W5 mount ───────────────────────────────────────
function httpCall(base, method, p, { body, token = 'tok-a' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: Object.assign({ authorization: 'Bearer ' + token },
          body ? { 'content-type': 'application/json' } : {}) },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('live HTTP: panel is served; artifacts API round-trips what the UI consumes', async () => {
  process.env.TG_ARTIFACTS_FILE = path.join(require('node:os').tmpdir(), 'panel-art-' + process.pid + '.json');
  const { Gateway } = require('../src/gateway/server');
  const APP = path.join(__dirname, '..', 'app');
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
    dispatch: async () => ({ ok: true }),
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const base = 'http://127.0.0.1:' + port;
  try {
    const panelJs = await httpCall(base, 'GET', '/panels/artifacts.js');
    assert.equal(panelJs.status, 200);
    assert.match(panelJs.body, /TG_PANELS/);

    const created = await httpCall(base, 'POST', '/v2/artifacts', {
      body: JSON.stringify({ kind: 'code', title: 'panel-e2e', content: 'print("hi")' }),
    });
    assert.equal(created.status, 201);
    const id = JSON.parse(created.body).artifact.id;

    const list = JSON.parse((await httpCall(base, 'GET', '/v2/artifacts')).body);
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0].kind, 'code');
    assert.equal(list.artifacts[0].bot, 'a');
    assert.equal(list.artifacts[0].version, 1);

    const upd = await httpCall(base, 'PUT', '/v2/artifacts/' + id, {
      body: JSON.stringify({ content: 'print("v2")' }),
    });
    assert.equal(upd.status, 200);
    const got = JSON.parse((await httpCall(base, 'GET', '/v2/artifacts/' + id)).body);
    assert.equal(got.artifact.versions.length, 2);
    assert.equal(got.artifact.versions[1].content, 'print("v2")');
  } finally {
    await new Promise((r) => server.close(r));
  }
});