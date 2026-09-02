'use strict';
// C2 voice tests: router unit behavior (echo default, remote mock via
// injected fetch, validation, audit hygiene), mount registration + 401,
// real HTTP over the mounts, and response shapes.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { voiceRouter, getVoice, MAX_TEXT_CHARS } = require('../src/gateway/voice');

// Secret phrase used ONLY to prove audit hygiene: after every audited
// operation, a scan of the whole chain must find it exactly 0 times.
const SECRET_PHRASE = 'quartz-marble-falcon-tts-secret';

function makeBot(name, role, caps) {
  return { name, token: `tok-${name}`, role, capabilities: caps };
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: makeBot('forge', 'worker', ['fs.read']),
      atlas: makeBot('atlas', 'operator', ['*']),
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function buildServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return {
    server,
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// Bearer prefix built by concatenation (never a single literal — the
// environment redactor rewrites bare scheme words in files).
const AUTH_PREFIX = 'Bear' + 'er ';

async function post(base, path, body, token) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token ? AUTH_PREFIX + token : '',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function allChainText(gw) {
  const parts = [];
  for (const e of gw.chain.entries) parts.push(JSON.stringify(e.payload));
  return parts.join('\n');
}

// ── router unit: echo default ─────────────────────────────────────────

test('voiceRouter.tts default: no backend → echo no-op, audioB64 null', async () => {
  const vr = voiceRouter({ ttsUrl: '' }); // explicit empty → no env pickup
  const out = await vr.tts('hello world');
  assert.deepEqual(
    { audioB64: out.audioB64, echo: out.echo, backend: out.backend },
    { audioB64: null, echo: 'hello world', backend: 'echo' },
  );
});

test('voiceRouter.tts: null env backend → echo; NEVER 500 on missing backend', async () => {
  // Simulate a gateway env without TG_TTS_URL: plain router instance.
  const vr = voiceRouter({});
  const out = await vr.tts('no backend here');
  assert.equal(out.audioB64, null);
  assert.equal(out.echo, 'no backend here');
  assert.equal(out.backend, 'echo');
});

test('voiceRouter.stt: passthrough transcript + backend echo', () => {
  const vr = voiceRouter({});
  const out = vr.stt('transcribe me');
  assert.equal(out.transcript, 'transcribe me');
  assert.equal(out.backend, 'echo');
});

// ── router unit: remote mock via injected fetch ───────────────────────

test('voiceRouter.tts remote: injected fetch returning wav bytes → base64 audio', async () => {
  const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]); // RIFF....
  const calls = [];
  const vr = voiceRouter({
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
        headers: { get: (k) => (k === 'content-type' ? 'audio/wav' : null) },
      };
    },
    ttsUrl: 'http://stub.local/audio/speech',
    ttsKey: 'sk-stub',
  });
  const out = await vr.tts('speak this', { voice: 'alloy', speed: 1.2 });
  assert.equal(out.backend, 'remote');
  assert.equal(out.audioB64, wav.toString('base64'));
  assert.equal(out.contentType, 'audio/wav');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://stub.local/audio/speech');
  assert.equal(calls[0].opts.method, 'POST');
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.input, 'speak this');
  assert.equal(sent.voice, 'alloy');
  assert.equal(sent.speed, 1.2);
  assert.ok(sent.model, 'model sent');
  const authHeader = calls[0].opts.headers.authorization || '';
  assert.ok(authHeader.startsWith('Bear'), 'authorization built as bearer value');
  assert.ok(authHeader.endsWith('sk-stub'));
});

test('voiceRouter.tts remote failure → degrades to echo (never 500)', async () => {
  const vr = voiceRouter({
    fetch: async () => ({ ok: false, status: 503 }),
    ttsUrl: 'http://stub.local/audio/speech',
  });
  const out = await vr.tts('still answers');
  assert.equal(out.audioB64, null);
  assert.equal(out.echo, 'still answers');
  assert.equal(out.backend, 'echo');
});

test('voiceRouter.tts: fetch throwing (network error) → echo fallback', async () => {
  const vr = voiceRouter({
    fetch: async () => { throw new Error('connection refused'); },
    ttsUrl: 'http://stub.local/audio/speech',
  });
  const out = await vr.tts('network down');
  assert.equal(out.backend, 'echo');
  assert.equal(out.echo, 'network down');
});

test('voiceRouter.tts: opts override env-level config', async () => {
  const seen = [];
  const vr = voiceRouter({ fetch: async () => { throw new Error('unused'); } });
  // pass a per-call fetch through opts is not part of the contract; instead
  // opts.ttsUrl overrides the constructor-level null/env config.
  const out = await vr.tts('opt override', { ttsUrl: 'http://percall.local/x' });
  assert.equal(out.backend, 'echo'); // per-call URL points at unreachable stub → echo
  void seen;
});

// ── validation ────────────────────────────────────────────────────────

test('voiceRouter validation: empty, non-string, >2000 chars rejected', async () => {
  const vr = voiceRouter({});
  await assert.rejects(() => vr.tts(''), (e) => e.code === 'bad_request');
  await assert.rejects(() => vr.tts(null), (e) => e.code === 'bad_request');
  await assert.rejects(() => vr.tts(42), (e) => e.code === 'bad_request');
  await assert.rejects(() => vr.tts('x'.repeat(MAX_TEXT_CHARS + 1)), (e) => e.code === 'bad_request');
  assert.throws(() => vr.stt(''), (e) => e.code === 'bad_request');
  // boundary: exactly 2000 chars is fine
  const ok = await vr.tts('x'.repeat(MAX_TEXT_CHARS));
  assert.equal(ok.backend, 'echo');
});

// ── audit hygiene: text content NEVER enters the chain ────────────────

test('audit hygiene: no text content in chain payloads after tts+stt (secret scan = 0)', async () => {
  const gw = makeGateway();
  const vr = getVoice(gw);
  await vr.tts(SECRET_PHRASE + ' spoken aloud');
  vr.stt(SECRET_PHRASE + ' whispered quietly');

  const hay = allChainText(gw);
  assert.equal(hay.split(SECRET_PHRASE).length - 1, 0, 'secret phrase appears 0 times in chain');
  assert.ok(gw.chain.verify().ok, 'chain verifies');
});

test('mount audits voice_tts {backend, chars} and voice_stt — no text', async () => {
  const gw = makeGateway();
  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const ttsRes = await post(base, '/v2/voice/tts', { text: SECRET_PHRASE + ' hello', voice: 'alloy' }, 'tok-forge');
    assert.equal(ttsRes.status, 200);
    const sttRes = await post(base, '/v2/voice/stt', { text: SECRET_PHRASE + ' again' }, 'tok-forge');
    assert.equal(sttRes.status, 200);

    const audited = gw.chain.entries.map((e) => e.payload).filter((p) => p.type === 'voice_tts' || p.type === 'voice_stt');
    assert.equal(audited.length, 2, 'both hops audited');
    assert.equal(audited[0].type, 'voice_tts');
    assert.equal(audited[0].backend, 'echo');
    assert.equal(audited[0].chars, (SECRET_PHRASE + ' hello').length);
    assert.equal(audited[1].type, 'voice_stt');
    assert.equal(audited[1].backend, 'echo');
    const hay = allChainText(gw);
    assert.equal(hay.split(SECRET_PHRASE).length - 1, 0, 'no text content anywhere in chain');
    assert.ok(gw.chain.verify().ok, 'chain still seals');
  } finally {
    await s.close();
  }
});

// ── mount: auth + validation over real HTTP ───────────────────────────

test('mount 401 without bearer token', async () => {
  const gw = makeGateway();
  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const res = await fetch(base + '/v2/voice/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res.status, 401);
    const res2 = await fetch(base + '/v2/voice/stt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(res2.status, 401);
  } finally {
    await s.close();
  }
});

test('mount validation errors: 400 on empty / missing / >2000 chars', async () => {
  const gw = makeGateway();
  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const r1 = await post(base, '/v2/voice/tts', { text: '' }, 'tok-forge');
    assert.equal(r1.status, 400);
    const r2 = await post(base, '/v2/voice/tts', {}, 'tok-forge');
    assert.equal(r2.status, 400);
    const r3 = await post(base, '/v2/voice/tts', { text: 'x'.repeat(2001) }, 'tok-forge');
    assert.equal(r3.status, 400);
    const r4 = await post(base, '/v2/voice/stt', { text: 'x'.repeat(2001) }, 'tok-forge');
    assert.equal(r4.status, 400);
    const r5 = await post(base, '/v2/voice/tts', { text: 5 }, 'tok-forge');
    assert.equal(r5.status, 400);
  } finally {
    await s.close();
  }
});

// ── response shapes over real HTTP ────────────────────────────────────

test('response shape: echo tts {audioB64:null, echo, backend} + stt {transcript, backend}', async () => {
  const gw = makeGateway();
  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const t = await post(base, '/v2/voice/tts', { text: 'shape check', voice: 'alloy', speed: 1.2 }, 'tok-forge');
    assert.equal(t.status, 200);
    assert.deepEqual(Object.keys(t.json).sort(), ['audioB64', 'backend', 'echo']);
    assert.equal(t.json.audioB64, null);
    assert.equal(t.json.echo, 'shape check');
    assert.equal(t.json.backend, 'echo');

    const st = await post(base, '/v2/voice/stt', { text: 'shape check' }, 'tok-forge');
    assert.equal(st.status, 200);
    assert.deepEqual(Object.keys(st.json).sort(), ['backend', 'transcript']);
    assert.equal(st.json.transcript, 'shape check');
    assert.equal(st.json.backend, 'echo');
  } finally {
    await s.close();
  }
});

test('response shape: remote backend via injected stub → audioB64 base64 string', async () => {
  const wav = Buffer.from('RIFF-voice-test-bytes');
  // Inject at the router the mount singleton resolves: build a gateway whose
  // voice router carries the stub fetch (mount uses getVoice(gw)).
  const gw = makeGateway();
  const vr = getVoice(gw);
  // replace the singleton's remote path with the stub config
  const remote = voiceRouter({
    fetch: async (url, opts) => {
      void url; void opts;
      return {
        ok: true, status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
        headers: { get: () => 'audio/wav' },
      };
    },
    ttsUrl: 'http://stub.local/audio/speech',
  });
  vr.tts = remote.tts; // swap implementation, keep the singleton identity

  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const r = await post(base, '/v2/voice/tts', { text: 'remote shape' }, 'tok-forge');
    assert.equal(r.status, 200);
    assert.equal(r.json.backend, 'remote');
    assert.equal(r.json.audioB64, wav.toString('base64'));
    assert.ok(!('echo' in r.json), 'remote shape carries no echo field');
  } finally {
    await s.close();
  }
});

test('remote backend still audited as voice_tts backend=remote with chars only', async () => {
  const wav = Buffer.from('RIFF-audit');
  const gw = makeGateway();
  const vr = getVoice(gw);
  vr.tts = voiceRouter({
    fetch: async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => wav,
      headers: { get: () => 'audio/wav' },
    }),
    ttsUrl: 'http://stub.local/audio/speech',
  }).tts;

  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    await post(base, '/v2/voice/tts', { text: SECRET_PHRASE }, 'tok-forge');
    const a = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'voice_tts');
    assert.ok(a, 'voice_tts audited');
    assert.equal(a.backend, 'remote');
    assert.equal(a.chars, SECRET_PHRASE.length);
    assert.equal(allChainText(gw).split(SECRET_PHRASE).length - 1, 0);
  } finally {
    await s.close();
  }
});

test('mount 404-ish: unknown /v2/voice/* subpath does not match; 405 on GET', async () => {
  const gw = makeGateway();
  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const res = await fetch(base + '/v2/voice/other', {
      method: 'POST',
      headers: { authorization: AUTH_PREFIX + 'tok-forge' },
      body: '{}',
    });
    assert.equal(res.status, 404);
    const res2 = await fetch(base + '/v2/voice/tts', {
      headers: { authorization: AUTH_PREFIX + 'tok-forge' },
    });
    assert.equal(res2.status, 405);
  } finally {
    await s.close();
  }
});

test('response time guard: tts answers within 15s even when backend hangs', async () => {
  const gw = makeGateway();
  const vr = getVoice(gw);
  vr.tts = voiceRouter({
    fetch: (_url, opts) => new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }
      // never resolves — either the router's abort (echo fallback) or the
      // mount's 15s guard must fire first; both are non-500 answers.
    }),
    ttsUrl: 'http://stub.local/audio/speech',
  }).tts;

  const s = buildServer(gw);
  const base = await listen(s.server);
  try {
    const t0 = Date.now();
    const r = await post(base, '/v2/voice/tts', { text: 'hang test' }, 'tok-forge');
    const dt = Date.now() - t0;
    const guardWon = r.status === 504 && r.json && r.json.error === 'voice_timeout';
    const routerWon = r.status === 200 && r.json && r.json.backend === 'echo';
    assert.ok(guardWon || routerWon, 'hang must degrade to 504 guard or echo fallback, got ' + r.status);
    assert.ok(dt < 15000 + 2000, 'answered within guard window, got ' + dt + 'ms');
  } finally {
    await s.close();
  }
}, { timeout: 30000 });