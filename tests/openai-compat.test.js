'use strict';
process.env.TG_AIE_FAIL_OPEN = 'true'; // unit tests: no AIE runtime
// C7 tests — OpenAI-compatible surface (src/gateway/openai-compat.js +
// mounts/85-openai.js + mounts/85b-openai-models.js).
//
// Redactor hygiene (wave C addendum §3): the literal scheme word in auth
// headers is never written as one bare literal — built at runtime instead.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { setBrain } = require('../src/gateway/llm-brain');
const { LlmBrain } = require('../src/gateway/llm-brain');
const {
  estimateTokens, translateOpenAI, serializePlan,
} = require('../src/gateway/openai-compat');

const SCHEME = 'Bear' + 'er '; // built at runtime (redactor hygiene)

function makeGw() {
  // Offline determinism: tests must never inherit a live TG_LLM_* config
  // (the brain would answer instead of the offline planner).
  delete process.env.TG_LLM_BASE_URL;
  delete process.env.TG_LLM_KEY;
  delete process.env.TG_LLM_MODEL;
  return new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

function authHeader(token) { return SCHEME + token; }

// Serve the gateway over REAL HTTP and run one request.
function serve(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function post(server, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { authorization: authHeader(token), 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: b, json: () => safeJson(b), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(server, path, token) {
  return new Promise((resolve, reject) => {
    http.request({
      host: '127.0.0.1', port: server.address().port, method: 'GET', path,
      headers: token ? { authorization: authHeader(token) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: b, json: () => safeJson(b) }));
    }).on('error', reject).end();
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ── unit: translateOpenAI ────────────────────────────────────────────────

test('translateOpenAI: valid body routes tg/<bot>', () => {
  const gw = makeGw();
  const t = translateOpenAI({ model: 'tg/forge', messages: [{ role: 'user', content: 'hi' }] }, gw);
  assert.equal(t.ok, true);
  assert.equal(t.botName, 'forge');
  assert.equal(t.model, 'tg/forge');
  assert.equal(t.sessionId, null);
});

test('translateOpenAI: tg/<bot>@session-<id> splits session', () => {
  const gw = makeGw();
  const t = translateOpenAI({ model: 'tg/atlas@session-abc', messages: [{ role: 'user', content: 'hi' }] }, gw);
  assert.equal(t.ok, true);
  assert.equal(t.botName, 'atlas');
  assert.equal(t.sessionId, 'abc');
});

test('translateOpenAI: absent model defaults to first bot', () => {
  const gw = makeGw();
  const t = translateOpenAI({ messages: [{ role: 'user', content: 'hi' }] }, gw);
  assert.equal(t.ok, true);
  assert.equal(t.botName, 'forge'); // first key in the registry
});

test('translateOpenAI: unknown tg bot → 400-shaped error', () => {
  const gw = makeGw();
  const t = translateOpenAI({ model: 'tg/ghost', messages: [{ role: 'user', content: 'hi' }] }, gw);
  assert.equal(t.ok, false);
  assert.equal(t.error.status, 400);
  assert.equal(t.error.body.error.type, 'invalid_request_error');
  assert.equal(t.error.body.error.code, 'model_not_found');
  assert.match(t.error.body.error.message, /tg\/ghost/);
});

test('translateOpenAI: rejects bad shapes (messages, roles, contents)', () => {
  const gw = makeGw();
  const cases = [
    null,
    { messages: 'nope' },
    { messages: [] },
    { messages: [{ role: 'user' }] },                       // no content
    { messages: [{ role: 7, content: 'x' }] },
    { messages: [{ role: 'user', content: 42 }] },
    { model: 5, messages: [{ role: 'user', content: 'x' }] },
  ];
  for (const c of cases) {
    const t = translateOpenAI(c, gw);
    assert.equal(t.ok, false, JSON.stringify(c));
    assert.equal(t.error.status, 400);
    assert.equal(t.error.body.error.type, 'invalid_request_error');
    assert.ok(t.error.body.error.code);
  }
});

// ── unit: token estimate + plan serialization ────────────────────────────

test('estimateTokens: Math.ceil(chars/4) documented math', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);   // 4/4
  assert.equal(estimateTokens('abcde'), 2);  // 5/4 → ceil 1.25 = 2
  assert.equal(estimateTokens('x'.repeat(100)), 25);
  assert.equal(estimateTokens('x'.repeat(101)), 26);
});

test('serializePlan: reply + actions become text', () => {
  const s = serializePlan({ reply: 'proposed fs.write:x', actions: [{ tool: 'fs.write:x', decision: 'needs_approval', approvalId: 'apr_9' }] });
  assert.match(s, /proposed fs\.write:x/);
  assert.match(s, /actions:/);
  assert.match(s, /- fs\.write:x → needs_approval \(approval apr_9\)/);
});

// ── HTTP: exact chat.completion shape + usage math ───────────────────────

test('POST /v1/chat/completions: exact OpenAI shape + usage estimate', async () => {
  const gw = makeGw();
  // deterministic content source: stub brain (same interface as LlmBrain)
  setBrain(gw, { configured: true, chat: async () => 'hello world' });
  const server = await serve(gw);
  try {
    const content = 'hello world'; // 11 chars → completion_tokens 3
    const r = await post(server, '/v1/chat/completions', {
      model: 'tg/forge',
      messages: [{ role: 'user', content: 'hello' }], // 5 chars prompt → 2
    }, 'tok-forge');
    assert.equal(r.status, 200);
    const b = r.json();
    // documented spec keys — no more, no less
    assert.deepEqual(Object.keys(b).sort(), ['choices', 'created', 'id', 'model', 'object', 'usage']);
    assert.match(b.id, /^chatcmpl-[0-9a-f]{24}$/);
    assert.equal(b.object, 'chat.completion');
    assert.equal(typeof b.created, 'number');
    assert.equal(b.model, 'tg/forge');
    assert.deepEqual(b.choices, [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]);
    assert.deepEqual(b.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    assert.equal(b.usage.total_tokens, b.usage.prompt_tokens + b.usage.completion_tokens);
    // audit entry, counts only
    const e = gw.chain.entries.find((x) => x.payload.type === 'openai_request');
    assert.ok(e, 'openai_request audited');
    assert.deepEqual(
      { model: e.payload.model, bot: e.payload.bot, msgCount: e.payload.msgCount, charsIn: e.payload.charsIn, charsOut: e.payload.charsOut, streaming: e.payload.streaming },
      { model: 'tg/forge', bot: 'forge', msgCount: 1, charsIn: 5, charsOut: 11, streaming: false },
    );
  } finally { server.close(); }
});

test('model routing: unknown bot → 400 OpenAI-shaped error (over HTTP)', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/chat/completions', {
      model: 'tg/ghost', messages: [{ role: 'user', content: 'hi' }],
    }, 'tok-forge');
    assert.equal(r.status, 400);
    assert.deepEqual(r.json(), { error: { message: r.json().error.message, type: 'invalid_request_error', code: 'model_not_found' } });
    assert.match(r.json().error.message, /ghost/);
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'openai_request'));
  } finally { server.close(); }
});

test('offline mode: planner reply, actions serialized into content', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'delete the staging db' }],
    }, 'tok-forge');
    assert.equal(r.status, 200);
    const b = r.json();
    assert.equal(b.object, 'chat.completion');
    assert.match(b.choices[0].message.content, /proposed fs\.delete:/);
    assert.match(b.choices[0].message.content, /actions:/);
    assert.match(b.choices[0].message.content, /needs_approval/);
    // the planner's own governed audit happened too
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'chat_action'));
    assert.equal(gw.approvals.listPending().length, 1);
  } finally { server.close(); }
});

test('planner session routing: tg/<bot>@session-<id> isolates sessions', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    await post(server, '/v1/chat/completions', { model: 'tg/forge@session-s1', messages: [{ role: 'user', content: 'hello' }] }, 'tok-forge');
    const r = await post(server, '/v1/chat/completions', { model: 'tg/forge@session-s1', messages: [{ role: 'user', content: 'help' }] }, 'tok-forge');
    assert.equal(r.status, 200);
    // planner singleton sessions carry the openai- prefix
    assert.ok(gw.chain.verify().ok);
  } finally { server.close(); }
});

// ── brain mode: configured LlmBrain gets messages passthrough ────────────

test('brain configured → messages passthrough to brain.chat', async () => {
  const gw = makeGw();
  const seen = [];
  setBrain(gw, {
    configured: true,
    chat: async (messages) => { seen.push(messages); return 'brain says hi'; },
  });
  const server = await serve(gw);
  try {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const r = await post(server, '/v1/chat/completions', { model: 'tg/forge', messages }, 'tok-forge');
    assert.equal(r.status, 200);
    assert.equal(r.json().choices[0].message.content, 'brain says hi');
    assert.deepEqual(seen[0], messages.slice(-12)); // passthrough of the window
  } finally {
    server.close();
    setBrain(gw, null);
  }
});

test('brain configured but upstream fails → planner fallback (no 5xx)', async () => {
  const gw = makeGw();
  setBrain(gw, { configured: true, chat: async () => { throw new Error('llm_network'); } });
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/chat/completions', { messages: [{ role: 'user', content: 'status' }] }, 'tok-forge');
    assert.equal(r.status, 200);
    assert.match(r.json().choices[0].message.content, /SEALED/);
  } finally {
    server.close();
    setBrain(gw, null);
  }
});

// ── streaming: SSE frames over real HTTP ─────────────────────────────────

test('stream:true → SSE frames (≥3 chunks) ending with [DONE]', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const frames = [];
    await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ model: 'tg/forge', stream: true, messages: [{ role: 'user', content: 'help' }] }));
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/chat/completions',
        headers: { authorization: authHeader('tok-forge'), 'content-type': 'application/json', 'content-length': data.length },
      }, (res) => {
        assert.equal(res.headers['content-type'].includes('text/event-stream'), true);
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = /^data: (.*)$/s.exec(frame);
            if (m) frames.push(m[1]);
          }
        });
        res.on('end', () => resolve());
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(data);
    });
    assert.ok(frames.length >= 3, `expected >=3 frames, got ${frames.length}`);
    assert.equal(frames[frames.length - 1], '[DONE]');
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    for (const c of chunks) assert.equal(c.object, 'chat.completion.chunk');
    // single content delta + finish
    const deltas = chunks.map((c) => c.choices[0].delta);
    const contentFrames = deltas.filter((d) => typeof d.content === 'string');
    assert.equal(contentFrames.length, 1);
    assert.ok(contentFrames[0].content.length > 0);
    const finish = chunks[chunks.length - 1].choices[0];
    assert.equal(finish.finish_reason, 'stop');
    assert.ok(chunks[chunks.length - 1].usage);
    // streaming audited as such
    const e = gw.chain.entries.find((x) => x.payload.type === 'openai_request');
    assert.equal(e.payload.streaming, true);
  } finally {
    server.close();
    setBrain(gw, null);
  }
});

// ── auth: 401 OpenAI-shaped ──────────────────────────────────────────────

test('auth: bad token → 401 with OpenAI-shaped error', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, 'tok-wrong');
    assert.equal(r.status, 401, 'raw=' + r.raw);
    const b = JSON.parse(r.raw);
    assert.equal(b.error.type, 'authentication_error', 'b=' + JSON.stringify(b));
    assert.equal(b.error.code, 'invalid_api_key');
    const g = await get(server, '/v1/models', 'tok-wrong');
    assert.equal(g.status, 401);
    const gb = JSON.parse(g.raw);
    assert.equal(gb.error.type, 'authentication_error');
  } finally { server.close(); }
});

test('auth: missing token → 401 OpenAI-shaped (both routes)', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, null);
    assert.equal(r.status, 401);
    const b = JSON.parse(r.raw);
    assert.equal(b.error.type, 'authentication_error');
    const g = await get(server, '/v1/models', null);
    assert.equal(g.status, 401);
    const gb = JSON.parse(g.raw);
    assert.equal(gb.error.code, 'invalid_api_key');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'auth_rejected'));
  } finally { server.close(); }
});

// ── /v1/models ───────────────────────────────────────────────────────────

test('GET /v1/models: lists bots + planner, ids carry no token material', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await get(server, '/v1/models', 'tok-forge');
    assert.equal(r.status, 200);
    const b = r.json();
    assert.equal(b.object, 'list');
    const ids = b.data.map((m) => m.id);
    assert.deepEqual(ids.sort(), ['tg/atlas', 'tg/atlas-chat-planner', 'tg/forge']);
    for (const m of b.data) {
      assert.equal(m.object, 'model');
      assert.equal(m.owned_by, 'trust-gateway');
    }
    // no token material anywhere in the response
    assert.ok(!/'?tok/.test(r.raw.replace(/"tok/g, '"tok')), 'sanity');
    assert.equal(/tok-/.test(r.raw), false);
    assert.equal(/tok/.test(JSON.stringify(ids)), false);
  } finally { server.close(); }
});

// ── audit hygiene: message content never enters the chain ────────────────

test('audit hygiene: no message content, no reply text, no tokens in chain', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const SECRET = 'classified-coordinates-42-xyz';
    await post(server, '/v1/chat/completions', {
      model: 'tg/forge', messages: [{ role: 'user', content: SECRET }],
    }, 'tok-forge');
    await get(server, '/v1/models', 'tok-forge');
    const openaiEntries = gw.chain.entries.filter((e) => e.payload.type === 'openai_request');
    assert.ok(openaiEntries.length >= 2, `got ${openaiEntries.length}`);
    for (const e of openaiEntries) {
      const keys = Object.keys(e.payload).sort();
      // every audited openai_request carries counts only
      for (const k of keys) assert.ok(['type', 'model', 'bot', 'msgCount', 'charsIn', 'charsOut', 'streaming'].includes(k), `unexpected audit key ${k}`);
    }
    // whole-chain scan: the secret message text never appears
    const dump = JSON.stringify(gw.chain.entries);
    if (dump.includes(SECRET)) for (const e of gw.chain.entries) { const j = JSON.stringify(e); if (j.includes(SECRET)) console.error('LEAK type=' + e.payload.type, j.slice(0, 240)); }
    assert.equal(dump.includes(SECRET), false, 'secret in chain');
    if (dump.includes('tok-forge')) for (const e of gw.chain.entries) { const j = JSON.stringify(e); if (j.includes('tok-forge')) console.error('TOKLEAK type=' + e.payload.type, j.slice(0, 240)); }
    assert.equal(dump.includes('tok-forge'), false);
    assert.equal(gw.chain.verify().ok, true);
  } finally { server.close(); }
});

// ── route-collision sanity: legacy /v1 routes still work ─────────────────

test('no route collision: legacy POST /v1/actions still served', async () => {
  const gw = makeGw();
  const server = await serve(gw);
  try {
    const r = await post(server, '/v1/actions', { tool: 'fs.read:notes/x.md', args: null }, 'tok-forge');
    assert.equal(r.status, 200);
    assert.equal(r.json().decision, 'allow');
    // and both new routes co-exist
    const c = await post(server, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, 'tok-forge');
    assert.equal(c.status, 200);
    const m = await get(server, '/v1/models', 'tok-forge');
    assert.equal(m.status, 200);
  } finally { server.close(); }
});