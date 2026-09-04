'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// Wave C UI — Voice panel tests (C2).
// Covers: file presence, XSS policy (textContent only, no innerHTML), the
// TG_PANELS registration contract (id 'voice', title 'Voice'), use of the
// shared TG.api surface, speak → /v2/voice/tts, audioB64 decode → Audio
// playback (created in JS, never markup), transcribe → /v2/voice/stt,
// status-line updates, and the gateway actually serving /panels/voice.js
// over HTTP (Gateway({staticDir: app})).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'voice.js');

test('voice panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/voice.js exists');
});

test('voice panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'voice.js must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
  assert.ok(!/document\.write/.test(js), 'no document.write');
});

test('voice panel registers itself in TG_PANELS as voice/Voice', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]voice['"]/);
  assert.match(js, /title:\s*['"]Voice['"]/);
  assert.match(js, /render/);
});

test('voice panel uses the shared TG surface + voice endpoints', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/voice\/tts/);
  assert.match(js, /\/v2\/voice\/stt/);
});

test('voice panel: Audio player created in JS, never markup', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /new Audio\(/, 'audio player constructed in JS');
  assert.ok(!/<audio/i.test(js), 'no <audio> markup');
  assert.match(js, /audioB64/, 'decodes audioB64 when present');
});

// ── DOM behavior: run the panel inside a minimal DOM stub ─────────────

function makeNode(tag) {
  const node = {
    tag, className: '', children: [], textContent: '',
    style: {}, value: '', placeholder: '', rows: 0,
    listeners: {},
    append(...kids) { for (const k of kids) node.children.push(k); },
    addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
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

function installDom() {
  global.document = {
    createElement(tag) { return makeNode(tag); },
  };
  // minimal atob for base64 decode inside the panel
  if (!global.atob) {
    global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
  }
}

function installTG({ handlers = {}, posts = [] } = {}) {
  const createdAudio = [];
  const revokedUrls = [];
  global.window = {
    TG_PANELS: [],
    TG: {
      api: (p, opts) => {
        if (opts && opts.method === 'POST') {
          posts.push({ path: p, body: JSON.parse(opts.body) });
        }
        if (handlers[p]) return handlers[p](opts);
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
      onAudit: () => {},
    },
    Audio: function FakeAudio(url) {
      createdAudio.push({ url });
      this.url = url;
      this._listeners = {};
      this.play = () => { createdAudio.played = true; return Promise.resolve(); };
      this.addEventListener = (ev, fn) => { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
    },
    Blob: function FakeBlob(parts, opts) { this.parts = parts; this.type = opts && opts.type; },
    URL: {
      createObjectURL: (blob) => 'blob:voice-' + (blob && blob.type) + '-1',
      revokeObjectURL: (url) => revokedUrls.push(url),
    },
  };
  return { createdAudio, revokedUrls };
}

function loadPanel() {
  const src = fs.readFileSync(PANEL, 'utf8');
  // Safe: the function body is this repo's own panel source (trusted repo
  // content, read from disk) — no untrusted/interpolated input is involved.
  new Function('window', 'document', 'atob', src)(global.window, global.document, global.atob);
}

async function renderPanel(tgSetup) {
  installDom();
  const tg = installTG(tgSetup);
  loadPanel();
  const panel = global.window.TG_PANELS.find((p) => p.id === 'voice');
  assert.ok(panel, 'voice panel registered');
  const host = makeNode('#host');
  panel.render(host);
  return { panel, host, tg };
}

test('render: textarea + speak + transcribe buttons + status line', async () => {
  const { host } = await renderPanel({ handlers: {} });
  const ta = findIn(host, 'voice-text')[0];
  assert.ok(ta && ta.tag === 'textarea', 'textarea present');
  const speak = findIn(host, 'btn ok').find((b) => b.textContent === 'speak');
  const transcribe = findIn(host, 'btn').find((b) => b.textContent === 'transcribe');
  assert.ok(speak, 'speak button');
  assert.ok(transcribe, 'transcribe button');
  assert.ok(findIn(host, 'voice-status').length === 1, 'one status line');
});

test('speak: posts {text} to /v2/voice/tts', async () => {
  const posts = [];
  const { host } = await renderPanel({
    handlers: { '/v2/voice/tts': () => Promise.resolve({ audioB64: null, backend: 'echo', echo: 'hi' }) },
    posts,
  });
  const ta = findIn(host, 'voice-text')[0];
  ta.value = 'hello voice';
  const speak = findIn(host, 'btn ok').find((b) => b.textContent === 'speak');
  fire(speak, 'click');
  await new Promise((r) => setTimeout(r, 5));
  const p = posts.find((x) => x.path === '/v2/voice/tts');
  assert.ok(p, 'POST /v2/voice/tts fired');
  assert.equal(p.body.text, 'hello voice');
  const status = findIn(host, 'voice-status')[0];
  assert.match(status.textContent, /echo|no voice backend/);
});

test('speak: audioB64 present → decoded and played via JS-created Audio', async () => {
  const wavB64 = Buffer.from('RIFF-fake-wav').toString('base64');
  const { host, tg } = await renderPanel({
    handlers: {
      '/v2/voice/tts': () => Promise.resolve({ audioB64: wavB64, backend: 'remote', contentType: 'audio/wav' }),
    },
  });
  const ta = findIn(host, 'voice-text')[0];
  ta.value = 'play me';
  const speak = findIn(host, 'btn ok').find((b) => b.textContent === 'speak');
  fire(speak, 'click');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(tg.createdAudio.length === 1, 'one Audio created');
  assert.match(tg.createdAudio[0].url, /audio\/wav/, 'data URI from decoded bytes');
  assert.equal(tg.createdAudio.played, true, 'play() called');
  const status = findIn(host, 'voice-status')[0];
  assert.match(status.textContent, /playing/);
});

test('speak: empty textarea → status hint, no POST', async () => {
  const posts = [];
  const { host } = await renderPanel({ handlers: {}, posts });
  const speak = findIn(host, 'btn ok').find((b) => b.textContent === 'speak');
  fire(speak, 'click');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posts.length, 0, 'no POST fired');
  const status = findIn(host, 'voice-status')[0];
  assert.ok(status.textContent.length > 0, 'status hint shown');
});

test('transcribe: posts {text} to /v2/voice/stt and shows transcript', async () => {
  const posts = [];
  const { host } = await renderPanel({
    handlers: { '/v2/voice/stt': (opts) => Promise.resolve({ transcript: JSON.parse(opts.body).text, backend: 'echo' }) },
    posts,
  });
  const ta = findIn(host, 'voice-text')[0];
  ta.value = 'transcript me';
  const transcribe = findIn(host, 'btn').find((b) => b.textContent === 'transcribe');
  fire(transcribe, 'click');
  await new Promise((r) => setTimeout(r, 5));
  const p = posts.find((x) => x.path === '/v2/voice/stt');
  assert.ok(p, 'POST /v2/voice/stt fired');
  assert.equal(p.body.text, 'transcript me');
  const status = findIn(host, 'voice-status')[0];
  assert.match(status.textContent, /transcript me/);
});

test('API error → status line shows error, no throw', async () => {
  const { host } = await renderPanel({
    handlers: { '/v2/voice/tts': () => Promise.reject({ status: 401 }) },
  });
  const ta = findIn(host, 'voice-text')[0];
  ta.value = 'fails';
  const speak = findIn(host, 'btn ok').find((b) => b.textContent === 'speak');
  fire(speak, 'click');
  await new Promise((r) => setTimeout(r, 5));
  const status = findIn(host, 'voice-status')[0];
  assert.match(status.textContent, /error 401/);
});

// ── live HTTP: the gateway serves the panel file ──────────────────────

test('live HTTP: gateway serves /panels/voice.js (200, javascript)', async () => {
  const gw = new Gateway({
    bots: { a: { token: 'tok-a', role: 'operator', capabilities: ['*'] } },
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/voice.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});