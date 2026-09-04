'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// Wave B UI — Rooms panel tests.
// Covers: file presence, XSS policy (textContent only), TG_PANELS contract,
// window.TG surface usage, render-cap constant, bot/human badges + kind
// colors in the DOM built by render() against a stubbed window.TG, live
// append from onAudit room_message payloads, post-as-forge body, and the
// gateway actually serving /panels/rooms.js over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'rooms.js');

test('rooms panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/rooms.js exists');
});

test('rooms panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'rooms.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
});

test('rooms panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]rooms['"]/);
  assert.match(js, /title:\s*['"]Rooms['"]/);
  assert.match(js, /render/);
});

test('rooms panel uses the shared TG surface', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/rooms/);
  assert.match(js, /onAudit/);
});

test('rooms panel: 100-message render cap + post as forge + @mention shortcut', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /RENDER_CAP\s*=\s*100/, 'render cap constant = 100');
  assert.match(js, /from:\s*POST_AS|from:\s*['"]forge['"]/, 'posts with from: forge');
  assert.match(js, /POST_AS\s*=\s*['"]forge['"]/, 'POST_AS is forge');
  assert.match(js, /['"]@['"]\s*\+/, 'mention shortcut inserts @bot');
});

// ── DOM behavior: run the panel inside a minimal DOM stub ─────────────

function makeNode(tag) {
  const node = {
    tag, className: '', children: [], textContent: '',
    style: {}, value: '', placeholder: '',
    listeners: {},
    append(...kids) { for (const k of kids) node.children.push(k); },
    addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
    set textContentOverride(v) { node.textContent = v; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node._text || ''; },
    set(v) {
      node._text = v;
      if (v === '') node.children = [];
    },
  });
  return node;
}

function fire(node, ev) {
  for (const fn of (node.listeners[ev] || [])) fn({ preventDefault() {} });
}

function findIn(root, cls, out = []) {
  const toks = String(cls).split(' ');
  const has = String(root.className).split(' ');
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
  const created = [];
  global.document = {
    createElement(tag) { const n = makeNode(tag); created.push(n); return n; },
    createDocumentFragment() { return makeNode('#frag'); },
  };
  return created;
}

function installTG({ rooms = [], roomDetail = null, posts = [] } = {}) {
  const auditHandlers = [];
  global.window = {
    TG_PANELS: [],
    TG: {
      api: (p, opts) => {
        if (p === '/v2/rooms' && (!opts || !opts.method || opts.method === 'GET')) {
          return Promise.resolve({ rooms });
        }
        if (p === '/v2/rooms' && opts && opts.method === 'POST') {
          posts.push({ path: p, body: JSON.parse(opts.body) });
          return Promise.resolve({ ok: true, room: { id: 'room_new' } });
        }
        if (p === '/v2/rooms/room_1') return Promise.resolve({ room: roomDetail });
        if (p === '/v2/rooms/room_1/messages' && opts && opts.method === 'POST') {
          posts.push({ path: p, body: JSON.parse(opts.body) });
          return Promise.resolve({ ok: true });
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
  return { auditHandlers, posts };
}

function loadPanel() {
  const src = fs.readFileSync(PANEL, 'utf8');
  // Safe: the function body is this repo's own panel source (trusted repo
  // content, read from disk) — no untrusted/interpolated input is involved.
  // This mirrors how a browser <script src> would execute it.
  new Function('window', 'document', src)(global.window, global.document);
}

test('render: room list, create form, and message thread with badges + kind colors', async () => {
  installDom();
  installTG({
    rooms: [{ id: 'room_1', name: 'war room', members: { bots: ['forge'], humans: ['jonas'] }, turnLimit: 3, msgCap: 10, messageCount: 3 }],
    roomDetail: {
      id: 'room_1', name: 'war room',
      members: { bots: ['forge'], humans: ['jonas'] },
      messages: [
        { id: 'rm_1', from: 'forge', kind: 'message', body: 'hello', ts: 1756830000000 },
        { id: 'rm_2', from: 'jonas', kind: 'message', body: 'hi forge', ts: 1756830001000 },
        { id: 'rm_3', from: 'forge', kind: 'handoff', body: 'over to you', ts: 1756830002000 },
        { id: 'rm_4', from: 'forge', kind: 'proposal', body: { tool: 'fs.read', argsLength: 12 }, ts: 1756830003000 },
      ],
    },
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'rooms');
  assert.ok(panel, 'rooms panel registered');
  assert.equal(panel.title, 'Rooms');

  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));

  // create form exists with the two required inputs
  const form = findIn(host, 'room-create')[0];
  assert.ok(form, 'create form present');
  const inputs = form.children.filter((c) => c.tag === 'input');
  assert.ok(inputs.some((i) => i.placeholder === 'room name'), 'name input');
  assert.ok(inputs.some((i) => i.placeholder === 'bots (comma separated)'), 'bots input');

  // open the room → thread rendered
  const openBtn = findByText(host, 'open')[0];
  assert.ok(openBtn, 'open button');
  fire(openBtn, 'click');
  await new Promise((r) => setTimeout(r, 5));

  const rows = findIn(host, 'roommsg');
  assert.equal(rows.length, 4, 'all 4 messages rendered');
  assert.ok(findIn(host, 'kind-message').length >= 2, 'message kind color class');
  assert.ok(findIn(host, 'kind-handoff').length >= 1, 'handoff kind color class');
  assert.ok(findIn(host, 'kind-proposal').length >= 1, 'proposal kind color class');
  assert.ok(findIn(host, 'badge bot').length >= 1, 'bot badge');
  assert.ok(findIn(host, 'badge human').length >= 1, 'human badge');

  // proposal body object is JSON-stringified via textContent (no innerHTML)
  const bodies = findIn(host, 'roommsg-body').map((n) => n.textContent);
  assert.ok(bodies.some((b) => b.includes('fs.read')), 'proposal body rendered');
});

test('render: thread capped at 100 messages', async () => {
  installDom();
  const many = [];
  for (let i = 0; i < 130; i++) many.push({ id: 'rm_' + i, from: 'forge', kind: 'message', body: 'm' + i, ts: i });
  installTG({
    rooms: [{ id: 'room_1', name: 'big', members: { bots: ['forge'], humans: [] }, turnLimit: 3, msgCap: 200, messageCount: 130 }],
    roomDetail: { id: 'room_1', name: 'big', members: { bots: ['forge'], humans: [] }, messages: many },
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'rooms');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  fire(findByText(host, 'open')[0], 'click');
  await new Promise((r) => setTimeout(r, 5));
  const rows = findIn(host, 'roommsg');
  assert.equal(rows.length, 100, 'exactly 100 rows rendered (last 100)');
  const lastBody = findIn(host, 'roommsg-body').map((n) => n.textContent).pop();
  assert.equal(lastBody, 'm129', 'the most recent message is kept');
});

test('live-append: room_message audit for the open room appends to the thread', async () => {
  installDom();
  const tg = installTG({
    rooms: [{ id: 'room_1', name: 'live', members: { bots: ['forge', 'atlas'], humans: ['jonas'] }, turnLimit: 3, msgCap: 10, messageCount: 1 }],
    roomDetail: {
      id: 'room_1', name: 'live', members: { bots: ['forge', 'atlas'], humans: ['jonas'] },
      messages: [{ id: 'rm_1', from: 'jonas', kind: 'message', body: 'start', ts: 1 }],
    },
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'rooms');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  fire(findByText(host, 'open')[0], 'click');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(findIn(host, 'roommsg').length, 1);

  // frame carrying body → direct append
  tg.auditHandlers[0]({ ts: 1756830000000, payload: { type: 'room_message', roomId: 'room_1', messageId: 'rm_2', from: 'atlas', kind: 'message', body: 'live hello' } });
  assert.equal(findIn(host, 'roommsg').length, 2, 'appended live');
  const appended = findIn(host, 'roommsg-body').map((n) => n.textContent).pop();
  assert.equal(appended, 'live hello');

  // duplicate / fanout hop with same messageId → not appended twice
  tg.auditHandlers[0]({ payload: { type: 'room_message', roomId: 'room_1', messageId: 'rm_2', from: 'atlas', kind: 'fanout' } });
  assert.equal(findIn(host, 'roommsg').length, 2, 'deduped by messageId');

  // other room → ignored
  tg.auditHandlers[0]({ payload: { type: 'room_message', roomId: 'room_other', messageId: 'rm_9', from: 'forge', kind: 'message', body: 'x' } });
  assert.equal(findIn(host, 'roommsg').length, 2, 'non-matching room ignored');
});

test('post message input sends {from:"forge", kind:"message", body} and refreshes', async () => {
  installDom();
  const tg = installTG({
    rooms: [{ id: 'room_1', name: 'send', members: { bots: ['forge'], humans: ['jonas'] }, turnLimit: 3, msgCap: 10, messageCount: 1 }],
    roomDetail: {
      id: 'room_1', name: 'send', members: { bots: ['forge'], humans: ['jonas'] },
      messages: [{ id: 'rm_1', from: 'jonas', kind: 'message', body: 'start', ts: 1 }],
    },
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'rooms');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  fire(findByText(host, 'open')[0], 'click');
  await new Promise((r) => setTimeout(r, 5));

  const bodyIn = findIn(host, 'room-body-in')[0];
  assert.ok(bodyIn, 'post-message input present');
  bodyIn.value = 'hello @atlas please check';
  const sendForm = findIn(host, 'room-send')[0];
  fire(sendForm, 'submit');
  await new Promise((r) => setTimeout(r, 5));

  const post = tg.posts.find((p) => p.path === '/v2/rooms/room_1/messages');
  assert.ok(post, 'POST /v2/rooms/:id/messages fired');
  assert.equal(post.body.from, 'forge', 'posts as forge');
  assert.equal(post.body.kind, 'message');
  assert.equal(post.body.body, 'hello @atlas please check', 'mention text included');
});

test('mention shortcut inserts @bot into the input', async () => {
  installDom();
  installTG({
    rooms: [{ id: 'room_1', name: 'mentions', members: { bots: ['forge', 'atlas'], humans: [] }, turnLimit: 3, msgCap: 10, messageCount: 0 }],
    roomDetail: { id: 'room_1', name: 'mentions', members: { bots: ['forge', 'atlas'], humans: [] }, messages: [] },
  });
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'rooms');
  const host = makeNode('#host');
  panel.render(host);
  await new Promise((r) => setTimeout(r, 5));
  fire(findByText(host, 'open')[0], 'click');
  await new Promise((r) => setTimeout(r, 5));

  const mentionBtns = findIn(host, 'mention-btn');
  assert.deepEqual(mentionBtns.map((b) => b.textContent), ['@forge', '@atlas'], 'one shortcut per bot member');
  const bodyIn = findIn(host, 'room-body-in')[0];
  fire(mentionBtns[0], 'click');
  assert.equal(bodyIn.value, '@forge ', 'inserts @bot + space');
  fire(mentionBtns[1], 'click');
  assert.equal(bodyIn.value, '@forge @atlas ', 'appends further mentions');
});

test('live HTTP: gateway serves /panels/rooms.js', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/rooms.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});