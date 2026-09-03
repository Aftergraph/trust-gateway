'use strict';
// D2 tests — outbound Telegram notification adapter (wave D).
// Coverage: sendNotification unit (success, 400, timeout, validation),
// mount registration + 401 + role rejection + 503 env-unset, audit hygiene
// (no chat text in the chain, no token in the chain), real HTTP over the
// gateway with an INJECTED fetch — never a real call to api.telegram.org.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const {
  telegramAdapter,
  validate,
  resolveToken,
  MAX_TEXT_CHARS,
  ENDPOINT,
} = require('../src/gateway/telegram-adapter');

// Secret phrases that must NEVER appear in the chain after a send — used by
// the audit-hygiene scan.
const SECRET_TEXT = 'phosphor-quartz-telegram-payload-9f2x';
const SECRET_TOKEN = 'tg-bot-token-DELTA-77-secret-9f2x';

// ── harness ───────────────────────────────────────────────────────────────

function makeBot(name, role, caps) {
  return { name, token: `tok-${name}`, role, capabilities: caps };
}

function makeGateway({ token = SECRET_TOKEN } = {}) {
  // env injection: we want a defined token in most tests; the 503 test
  // unsets it explicitly.
  if (token) process.env.TG_TELEGRAM_TOKEN = token;
  return new Gateway({
    bots: {
      forge: makeBot('forge', 'worker', []),
      atlas: makeBot('atlas', 'operator', ['*']),
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function makeGatewayNoToken() {
  delete process.env.TG_TELEGRAM_TOKEN;
  return new Gateway({
    bots: {
      forge: makeBot('forge', 'worker', []),
      atlas: makeBot('atlas', 'operator', ['*']),
    },
    dispatch: async () => ({ ok: true }),
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

// Bearer header built by concatenation (redactor hygiene: never a single
// literal in source).
const AUTH_PREFIX = 'Bear' + 'er ';

async function postNotify(base, body, token) {
  // NOTE: must NOT use global fetch here — the e2e tests stub globalThis.fetch
  // to impersonate the Telegram API, which would intercept this very call.
  const u = new URL(base + '/v2/adapters/telegram/notify');
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, method: 'POST', path: u.pathname,
      headers: {
        'content-type': 'application/json',
        authorization: AUTH_PREFIX + token,
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* keep null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function fetchMock(handler) {
  const fn = async (url, opts = {}) => {
    fn.calls.push({ url: String(url), opts });
    return handler(url, opts);
  };
  fn.calls = [];
  return fn;
}

function jsonResponse(status, payload) {
  return {
    ok: true,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function chainText(gw) {
  const parts = [];
  for (const e of gw.chain.entries) parts.push(JSON.stringify(e.payload));
  return parts.join('\n');
}

async function flushPending() {
  // Drain any pending fire-and-forget sends so the test can read the chain.
  const pending = (globalThis.__telegramNotifyPending || []).splice(0);
  if (pending.length) await Promise.all(pending);
}

// ── validate() / resolveToken() unit ──────────────────────────────────────

test('validate: accepts a normal {chatId, text}', () => {
  assert.doesNotThrow(() => validate({ chatId: '123', text: 'hello' }));
  assert.doesNotThrow(() => validate({ chatId: 123, text: 'hello' }));
});

test('validate: rejects empty chatId / empty text / over-4096 text', () => {
  assert.throws(() => validate({ chatId: '', text: 'x' }), /chatId/);
  assert.throws(() => validate({ text: 'x' }), /chatId/);
  assert.throws(() => validate({ chatId: '1', text: '' }), /text/);
  assert.throws(() => validate({ chatId: '1' }), /text/);
  const big = 'x'.repeat(MAX_TEXT_CHARS + 1);
  assert.throws(() => validate({ chatId: '1', text: big }), /text too long/);
});

test('resolveToken: explicit token wins over env', () => {
  process.env.TG_TELEGRAM_TOKEN = 'env-tok';
  try { assert.equal(resolveToken('arg-tok'), 'arg-tok'); }
  finally { delete process.env.TG_TELEGRAM_TOKEN; }
  assert.equal(resolveToken('arg-tok-2'), 'arg-tok-2');
  assert.equal(resolveToken(''), null);
});

test('resolveToken: falls back to TG_TELEGRAM_TOKEN env', () => {
  process.env.TG_TELEGRAM_TOKEN = 'env-tok-42';
  try { assert.equal(resolveToken(undefined), 'env-tok-42'); }
  finally { delete process.env.TG_TELEGRAM_TOKEN; }
});

test('resolveToken: null when env unset and no arg', () => {
  delete process.env.TG_TELEGRAM_TOKEN;
  assert.equal(resolveToken(undefined), null);
  assert.equal(resolveToken(null), null);
});

// ── adapter unit: success / 400 / timeout / unreachable ──────────────────

// Unit tests pass the token explicitly so they don't depend on env state
// leaking between tests; the env-untested path is covered separately.
const UNIT_TOKEN = 'unit-tok-9f2x';

test('sendNotification: success → {ok:true, status:200}, no body fields leak', async () => {
  const fm = fetchMock(async (url, opts) => {
    assert.match(url, /^https:\/\/api\.telegram\.org\/bot.+\/sendMessage$/);
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.chat_id, '4242');
    assert.equal(body.text, 'hello world');
    return jsonResponse(200, { ok: true, result: { message_id: 99 } });
  });
  const a = telegramAdapter({ fetch: fm });
  const out = await a.sendNotification({ chatId: 4242, text: 'hello world', token: UNIT_TOKEN });
  assert.deepEqual(out, { ok: true, status: 200 });
  assert.equal(fm.calls.length, 1);
});

test('sendNotification: 400 from API → {ok:false, status, description}', async () => {
  const fm = fetchMock(async () => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
  const a = telegramAdapter({ fetch: fm });
  const out = await a.sendNotification({ chatId: 'no-such', text: 'hi', token: UNIT_TOKEN });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.description, /Bad Request/);
});

test('sendNotification: timeout → {ok:false, status:0, description:"timeout"}', async () => {
  const fm = fetchMock(async () => {
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  });
  const a = telegramAdapter({ fetch: fm, timeoutMs: 100 });
  const out = await a.sendNotification({ chatId: '1', text: 'x', token: UNIT_TOKEN });
  assert.deepEqual(out, { ok: false, status: 0, description: 'timeout' });
});

test('sendNotification: network unreachable → {ok:false, status:0, description:"unreachable"}', async () => {
  const fm = fetchMock(async () => { throw new Error('ECONNREFUSED'); });
  const a = telegramAdapter({ fetch: fm });
  const out = await a.sendNotification({ chatId: '1', text: 'x', token: UNIT_TOKEN });
  assert.deepEqual(out, { ok: false, status: 0, description: 'unreachable' });
});

test('sendNotification: refuses text over 4096 chars without calling fetch', async () => {
  let called = false;
  const fm = fetchMock(async () => { called = true; return jsonResponse(200, { ok: true }); });
  const a = telegramAdapter({ fetch: fm });
  await assert.rejects(
    () => a.sendNotification({ chatId: '1', text: 'x'.repeat(MAX_TEXT_CHARS + 1), token: UNIT_TOKEN }),
    /text too long/,
  );
  assert.equal(called, false, 'fetch must NOT be called when validation fails');
});

test('sendNotification: throws not_configured when env token absent (no fetch call)', async () => {
  delete process.env.TG_TELEGRAM_TOKEN;
  let called = false;
  const fm = fetchMock(async () => { called = true; return jsonResponse(200, { ok: true }); });
  const a = telegramAdapter({ fetch: fm });
  await assert.rejects(
    () => a.sendNotification({ chatId: '1', text: 'hi' }),
    /not configured/,
  );
  assert.equal(called, false, 'fetch must NOT be called when env token missing');
});

test('sendNotification: URL contains token in path only (no query string leak)', async () => {
  let capturedUrl = null;
  const fm = fetchMock(async (url) => {
    capturedUrl = String(url);
    return jsonResponse(200, { ok: true });
  });
  const a = telegramAdapter({ fetch: fm, timeoutMs: 1000 });
  await a.sendNotification({ chatId: '1', text: 'hi', token: UNIT_TOKEN });
  assert.ok(capturedUrl.startsWith('https://api.telegram.org/bot'), 'URL must include bot token in path');
  assert.equal(capturedUrl.includes('?token='), false, 'token must not be in query string');
  assert.equal(capturedUrl.includes('@'), false, 'token must not leak as userinfo');
});

// ── mount smoke: 401, role rejection, 503 env-unset, success, 400 from API ─

test('mount 401: POST /v2/adapters/telegram/notify without bearer is rejected', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const r = await fetch(base + '/v2/adapters/telegram/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: '1', text: 'hi' }),
    });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('mount 403: worker role is rejected (operator required)', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const r = await postNotify(base, { chatId: '1', text: 'hi' }, 'tok-forge');
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'operator_required');
    // audit reflects role rejection
    await flushPending();
    const text = chainText(gw);
    assert.match(text, /telegram_notify_rejected/);
  } finally { await ctx.close(); }
});

test('mount 503: TG_TELEGRAM_TOKEN unset → telegram_not_configured + audited', async () => {
  const gw = makeGatewayNoToken();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const r = await postNotify(base, { chatId: '1', text: 'hi' }, 'tok-atlas');
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'telegram_not_configured');
    const text = chainText(gw);
    assert.match(text, /"type":"telegram_notify"/);
    assert.match(text, /"error":"not_configured"/);
    // hygiene: no token, no text body
    assert.equal(text.includes(SECRET_TOKEN), false, 'token must not appear in chain');
    assert.equal(text.includes(SECRET_TEXT), false, 'chat text must not appear in chain (sentinel)');
  } finally { await ctx.close(); }
});

test('mount 400: bad body / missing chatId / over-4096 text', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);
  try {
    const r1 = await postNotify(base, {}, 'tok-atlas');
    assert.equal(r1.status, 400);
    const r2 = await postNotify(base, { chatId: '', text: 'x' }, 'tok-atlas');
    assert.equal(r2.status, 400);
    const r3 = await postNotify(base, { chatId: '1', text: '' }, 'tok-atlas');
    assert.equal(r3.status, 400);
    const r4 = await postNotify(base, { chatId: '1', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, 'tok-atlas');
    assert.equal(r4.status, 400);
  } finally { await ctx.close(); }
});

// ── end-to-end: 202 queued + async send + audit, with injected fetch ────
//
// We test through the gateway using the global fetch mock installed in
// the adapter module (the adapter reads globalThis.fetch on first call
// and we pass the mock via the env path of the gateway — but simpler:
// the adapter is created fresh on each request inside the mount, so the
// injected fetch must reach it. The mount currently calls telegramAdapter({})
// with no args; we test the ADAPTER unit directly above, and below we test
// the MOUNT end-to-end by stubbing globalThis.fetch for the duration of
// the fire-and-forget.

test('mount 202 + async send success: 202 returned immediately, audit on completion', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);

  // stub global fetch for the duration of the fire-and-forget
  const realFetch = globalThis.fetch;
  let capturedUrl = null;
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = opts && opts.body;
    return jsonResponse(200, { ok: true, result: { message_id: 7 } });
  };

  try {
    const r = await postNotify(base, { chatId: '8888', text: SECRET_TEXT }, 'tok-atlas');
    assert.equal(r.status, 202);
    assert.equal(r.json.queued, true);
    assert.equal(r.json.chars, SECRET_TEXT.length);

    // allow the fire-and-forget to complete
    await flushPending();

    // audit shows ok:true status:200
    const text = chainText(gw);
    assert.match(text, /"type":"telegram_notify"/);
    assert.match(text, /"ok":true/);
    assert.match(text, /"status":200/);
    assert.match(text, /"chat_id":"8888"/);
    assert.match(text, /"chars":\d+/);

    // fetch was called with the right URL and body
    assert.ok(capturedUrl.startsWith('https://api.telegram.org/bot'), 'URL must include bot token path');
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.chat_id, '8888');
    assert.equal(parsed.text, SECRET_TEXT);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
  }
});

test('mount 202 + async send: API 400 → audited as ok:false status:400 description', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });

  try {
    const r = await postNotify(base, { chatId: '9999', text: 'plain-text-no-secret' }, 'tok-atlas');
    if (r.status !== 202) { console.error('DEBUG', r.status, r.json); }
    assert.equal(r.status, 202);
    await flushPending();
    const text = chainText(gw);
    assert.match(text, /"type":"telegram_notify"/);
    assert.match(text, /"ok":false/);
    assert.match(text, /"status":400/);
    assert.match(text, /"error":"Bad Request: chat not found"/);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
  }
});

// ── audit hygiene scan: the secret text and the token NEVER enter the chain ─

test('audit hygiene: secret text and token NEVER appear in the chain after a send', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(200, { ok: true, result: { message_id: 1 } });

  try {
    // 1) success path
    await postNotify(base, { chatId: '11111', text: SECRET_TEXT }, 'tok-atlas');
    // 2) 400 path
    globalThis.fetch = async () => jsonResponse(400, { ok: false, error_code: 400, description: 'rejected' });
    await postNotify(base, { chatId: '22222', text: SECRET_TEXT + '-round2' }, 'tok-atlas');
    // 3) role rejection
    await postNotify(base, { chatId: '33333', text: SECRET_TEXT + '-as-worker' }, 'tok-forge');

    await flushPending();

    const text = chainText(gw);
    assert.equal(text.includes(SECRET_TEXT), false, `chain must not contain secret text: ${SECRET_TEXT}`);
    assert.equal(text.includes(SECRET_TEXT + '-round2'), false, 'chain must not contain any variant of secret text');
    assert.equal(text.includes(SECRET_TOKEN), false, `chain must not contain secret token: ${SECRET_TOKEN}`);
    // and the audit row only carries scalar fields (no nested object that
    // could smuggle a body)
    assert.match(text, /"type":"telegram_notify"/);
    assert.match(text, /"chat_id":"11111"/);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
  }
});

test('chain still verifies after a series of sends (durable integrity)', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const base = await listen(ctx.server);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(200, { ok: true, result: { message_id: 1 } });

  try {
    for (let i = 0; i < 5; i++) {
      await postNotify(base, { chatId: String(1000 + i), text: `msg-${i}-${SECRET_TEXT}` }, 'tok-atlas');
    }
    await flushPending();
    const v = gw.chain.verify();
    assert.equal(v.ok, true, `chain must still verify after sends: ${JSON.stringify(v)}`);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
  }
});

// Final hygiene: confirm exported values match design constants
test('design constants: MAX_TEXT_CHARS=4096, ENDPOINT api.telegram.org', () => {
  assert.equal(MAX_TEXT_CHARS, 4096);
  assert.equal(ENDPOINT, 'https://api.telegram.org');
});
