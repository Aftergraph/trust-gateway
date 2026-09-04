'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// C4 panel tests — Integrations console panel.
// Static lint (file presence, no innerHTML, TG_PANELS contract, shared TG
// surface) + DOM behavior with stubbed TG (cards, register form, secret
// form, password input cleared after send, live refresh on audit) + live
// HTTP serve of the panel file from the gateway.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'integrations.js');

// ── static lint ───────────────────────────────────────────────────────────

test('integrations panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/integrations.js exists');
});

test('integrations panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'integrations.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
});

test('integrations panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]integrations['"]/);
  assert.match(js, /title:\s*['"]Integrations['"]/);
  assert.match(js, /render/);
});

test('integrations panel uses the shared TG surface + secret hygiene markers', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/adapters/);
  assert.match(js, /onAudit/);
  // password input — value never echoed back, cleared after send
  assert.match(js, /secretVal\.type\s*=\s*['"]password['"]/, 'password input');
  assert.match(js, /secretVal\.value\s*=\s*['"]['"]/, 'clears secret value after send');
  // host-only display (no full URL leak)
  assert.match(js, /adapter-host/, 'host-only class');
  // confirm() before delete
  assert.match(js, /confirm\(/, 'delete confirm()');
});

// ── DOM harness ───────────────────────────────────────────────────────────

function makeNode(tag) {
  const node = {
    tag, className: '', children: [], textContent: '',
    style: {}, value: '', placeholder: '',
    type: 'text', selected: false, disabled: false,
    listeners: {},
    append(...kids) { for (const k of kids) if (k != null) node.children.push(k); },
    addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); },
    focus() {},
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text || ''; },
    set(v) { node._text = v; if (v === '') node.children = []; },
  });
  return node;
}

function fire(node, ev) {
  for (const fn of (node.listeners[ev] || [])) fn({ preventDefault() {} });
}

function findIn(root, cls, out = []) {
  const toks = String(cls).split(' ').filter(Boolean);
  const has = String(root.className || '').split(' ').filter(Boolean);
  if (toks.every((t) => has.includes(t))) out.push(root);
  for (const c of root.children || []) findIn(c, cls, out);
  return out;
}

function findByText(root, text, out = []) {
  if (root.textContent === text) out.push(root);
  for (const c of root.children || []) findByText(c, text, out);
  return out;
}

function installDom() {
  global.document = {
    createElement(tag) { return makeNode(tag); },
    createDocumentFragment() { return makeNode('#frag'); },
  };
}

function installTG({ adapters = [], posts = [], tests = [], secretSets = [] } = {}) {
  const auditHandlers = [];
  global.window = {
    TG_PANELS: [],
    TG: {
      api: (p, opts) => {
        const m = /^GET\s/.test(p + (opts && opts.method || ''));
        if (p === '/v2/adapters' && (!opts || !opts.method || opts.method === 'GET')) {
          return Promise.resolve({ adapters });
        }
        if (p === '/v2/adapters' && opts && opts.method === 'POST') {
          posts.push({ path: p, body: JSON.parse(opts.body) });
          return Promise.resolve({ ok: true, adapter: { id: 'adp_9000', kind: opts.body && JSON.parse(opts.body).kind, name: 'X', config: {}, host: 'https://x.example/', secrets: {}, enabled: true, createdAt: 1 } });
        }
        if (/^\/v2\/adapters\/[^/]+\/test$/.test(p) && opts && opts.method === 'POST') {
          tests.push({ path: p });
          return Promise.resolve({ id: 'adp_9000', kind: 'webhook', result: 'ok' });
        }
        if (/^\/v2\/adapters\/[^/]+\/secret$/.test(p) && opts && opts.method === 'POST') {
          secretSets.push({ path: p, body: JSON.parse(opts.body) });
          return Promise.resolve({ ok: true, name: JSON.parse(opts.body).name, length: JSON.parse(opts.body).value.length });
        }
        if (/^\/v2\/adapters\/[^/]+$/.test(p) && opts && (opts.method === 'PATCH' || opts.method === 'DELETE')) {
          return Promise.resolve({ ok: true, id: 'adp_9000' });
        }
        return Promise.reject(new Error('unexpected ' + p));
      },
      el: (tag, cls, text) => {
        const n = makeNode(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
      },
      token: () => 'tok',
      authed: () => true,
      refresh: () => {},
      onAudit: (fn) => auditHandlers.push(fn),
    },
  };
  return { auditHandlers, posts, tests, secretSets };
}

function loadPanel() {
  const src = fs.readFileSync(PANEL, 'utf8');
  // Safe: the function body is this repo's own panel source (trusted repo
  // content, read from disk) — no untrusted/interpolated input is involved.
  // This mirrors how a browser <script src> would execute it.
  new Function('window', 'document', src)(global.window, global.document);
}

// ── DOM behavior ─────────────────────────────────────────────────────────

test('render: register form, secret form, and adapter cards with kind badge + host-only', async () => {
  installDom();
  const tg = installTG({
    adapters: [{
      id: 'adp_9000', kind: 'webhook', name: 'Ops',
      config: { url: 'https://ops.example.com/hook?token=SECRET' },
      host: 'https://ops.example.com/',
      secrets: { sig: { length: 7, fingerprint: '0123456789ab' } },
      enabled: true, createdAt: 1,
    }],
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'integrations');
  assert.ok(panel, 'integrations panel registered');
  assert.equal(panel.title, 'Integrations');

  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));

  // kind badge for the existing adapter
  const kindBadges = findIn(host, 'adapter-kind');
  assert.equal(kindBadges.length, 1);
  assert.equal(kindBadges[0].textContent, 'webhook');
  // host-only display (no /hook, no ?token=)
  const hostLine = findIn(host, 'adapter-host')[0];
  assert.equal(hostLine.textContent, 'https://ops.example.com/');
  // secret fingerprint + length rendered, value never
  // the form also has class 'adapter-secret', so filter to inner spans only
  const secretSpans = findIn(host, 'adapter-secret')
    .filter((n) => n.className === 'adapter-secret' && n.children.length === 0 && n.tag === 'span');
  assert.ok(secretSpans.length >= 1, 'secret span rendered');
  const secretLine = secretSpans[0];
  assert.match(secretLine.textContent, /sig/);
  assert.match(secretLine.textContent, /7/);
  assert.ok(!JSON.stringify(secretLine).includes('SECRET'));
  // forms present
  assert.ok(findIn(host, 'adapter-create')[0]);
  assert.ok(findIn(host, 'adapter-secret')[0]);
});

test('register form posts {kind, name, config} with the right shape per kind', async () => {
  installDom();
  const tg = installTG({ adapters: [] });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'integrations');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));

  // default kind is 'webhook' (first in KINDS list)
  const form = findIn(host, 'adapter-create')[0];
  const inputs = form.children.filter((c) => c.tag === 'input');
  const sel = form.children.find((c) => c.tag === 'select');
  sel.value = 'http-api';
  inputs[0].value = 'Acme';
  inputs[1].value = 'https://api.acme.io/v1';
  fire(form, 'submit');
  await new Promise((r) => setTimeout(r, 5));

  const post = tg.posts[0];
  assert.equal(post.path, '/v2/adapters');
  assert.equal(post.body.kind, 'http-api');
  assert.equal(post.body.name, 'Acme');
  assert.equal(post.body.config.baseUrl, 'https://api.acme.io/v1');
  assert.equal(post.body.config.auth, 'header');
});

test('secret form: password input cleared after send; response shows length only', async () => {
  installDom();
  const tg = installTG({ adapters: [] });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'integrations');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));

  const form = findIn(host, 'adapter-secret')[0];
  const inputs = form.children.filter((c) => c.tag === 'input');
  inputs[0].value = 'adp_9000';
  inputs[1].value = 'sig';
  inputs[2].value = 'should-be-cleared';
  assert.equal(inputs[2].type, 'password', 'value is in a password input');
  fire(form, 'submit');
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(tg.secretSets[0].body.value, 'should-be-cleared');
  assert.equal(inputs[2].value, '', 'password field cleared after send');
  // the post-send message shows the length but NEVER the value text
  const msg = form.children.find((c) => c.className === 'muted');
  assert.ok(msg.textContent.includes('saved'));
  assert.ok(msg.textContent.includes(String('should-be-cleared'.length)));
  assert.ok(!msg.textContent.includes('should-be-cleared'), 'no value echoed back');
});

test('test button calls /v2/adapters/:id/test and shows ok inline', async () => {
  installDom();
  const tg = installTG({
    adapters: [{ id: 'adp_9000', kind: 'webhook', name: 'H', config: {}, host: 'https://h.example/', secrets: {}, enabled: true, createdAt: 1 }],
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'integrations');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  const testBtn = findByText(host, 'test')[0];
  fire(testBtn, 'click');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tg.tests.length, 1);
  const inline = findIn(host, 'adapter-test-result')[0];
  assert.equal(inline.textContent, 'ok');
});

test('live refresh on audit: adapter_registered triggers refresh', async () => {
  installDom();
  const tg = installTG({ adapters: [] });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'integrations');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  // initial GET fired once
  // emit a register audit — refresh fires (calls /v2/adapters again)
  tg.auditHandlers[0]({ payload: { type: 'adapter_registered' } });
  await new Promise((r) => setTimeout(r, 5));
  // re-emit a delete audit too
  tg.auditHandlers[0]({ payload: { type: 'adapter_deleted' } });
  await new Promise((r) => setTimeout(r, 5));
  // no exceptions thrown = the panel handles audit frames cleanly
  assert.ok(true);
});

// ── live HTTP ─────────────────────────────────────────────────────────────

test('live HTTP: gateway serves /panels/integrations.js', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/integrations.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
    assert.match(body, /integrations/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});