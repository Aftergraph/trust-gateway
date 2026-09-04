'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
process.env.TG_AIE_FAIL_OPEN = 'true'; // no AIE runtime in unit tests; fail-open for unit tests only
// W1 llm-brain tests — mock-upstream integration (rule 8: local
// http.createServer stub, never a real provider). Covers: chat wire format,
// proposal-goes-through-policy, no-args-leak-to-audit, empty response,
// timeout, upstream 5xx, and the /v2/chat/llm mount over real HTTP
// (bearer auth, validation, env-unset fallback).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { LlmBrain, setBrain, resolveConfig, extractAction, UNSET_REPLY } = require('../src/gateway/llm-brain');
const { estimateChat, LOCAL_LIMIT } = require('../src/gateway/llm-cost');

const KEY = 'sk-UNITTEST-KEY-9999'; // if this ever appears in output, we leaked

function makeGw() {
  const calls = [];
  const gw = new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*', 'fs.read:*'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (bot, tool, args) => {
      calls.push({ bot, tool, args });
      if (tool.startsWith('fs.read:')) return { path: tool.slice(8), content: 'ok' };
      if (tool.startsWith('fs.delete:')) return { deleted: tool.slice(10) };
      throw new Error('should_not_reach');
    },
  });
  return { gw, calls };
}

function brainFor(gw, url, extra = {}) {
  return new LlmBrain({ gateway: gw, baseUrl: url, apiKey: KEY, model: 'test-model', timeoutMs: 500, ...extra });
}

// OpenAI-shaped response body
function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

// Local mock upstream. handler(req, res, bodyObj). Records all requests.
function startStub(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(raw); } catch { /* keep null */ }
      seen.push({ url: req.url, headers: req.headers, body: parsed });
      handler(req, res, parsed);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      seen,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

// Real HTTP gateway front (mount smoke tests).
function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

const postLlm = (base, body, token = 'tok-forge') =>
  fetch(`${base}/v2/chat/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const auditJson = (gw) => JSON.stringify(gw.chain.entries);

// ── unit: config + tag parsing ────────────────────────────────────

test('config: base url defaults to Dialagram; key+model required', () => {
  const c = resolveConfig({ env: {} });
  assert.equal(c.baseUrl, 'https://api.dialagram.ai/v1');
  const brain = new LlmBrain({ env: { TG_LLM_MODEL: 'm' } });
  assert.equal(brain.configured, false, 'missing key → not configured');
  assert.match(UNSET_REPLY, /TG_LLM_BASE_URL/);
});

test('tag parse: tool = first token only, junk and control chars dropped', () => {
  assert.equal(extractAction('sure <action>shell.run --cmd=cat /etc/passwd</action>'), 'shell.run');
  assert.equal(extractAction('<action> fs.delete:prod </action>'), 'fs.delete:prod');
  assert.equal(extractAction('no tags here'), null);
  assert.equal(extractAction('<action>   </action>'), null, 'empty tag → no action');
});

// ── chat(): wire format against mock upstream ─────────────────────

test('chat(): OpenAI-shaped POST with bearer key, returns assistant text', async () => {
  const stub = await startStub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion('hello human')); });
  const { gw } = makeGw();
  try {
    const brain = brainFor(gw, stub.url);
    const out = await brain.chat('hi');
    assert.equal(out, 'hello human');
    assert.equal(stub.seen.length, 1);
    const r = stub.seen[0];
    assert.equal(r.url, '/v1/chat/completions');
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.equal(r.body.model, 'test-model');
    assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hi' }]);
  } finally { await stub.close(); }
});

// ── proposal-goes-through-policy (the core trust boundary) ────────

test('propose: model <action>shell.run</action> → policy, NOT execution', async () => {
  const stub = await startStub((req, res) => { res.end(completion('Wiping now! <action>shell.run</action>')); });
  const { gw, calls } = makeGw();
  try {
    const brain = brainFor(gw, stub.url);
    const out = await brain.propose('run the wipe script', { session: 'llm-1' });
    // destructive → needs_approval even though the reply said otherwise
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].tool, 'shell.run');
    assert.equal(out.actions[0].decision, 'needs_approval');
    assert.match(out.actions[0].approvalId, /^apr_/);
    assert.match(out.reply, /waiting for operator approval/);
    // THE assertion: nothing was dispatched
    assert.equal(calls.length, 0, 'dispatch must never run from brain output');
    // approval parked pending
    assert.equal(gw.approvals.listPending().length, 1);
    // decisions audited; model chatter never executed; chain sealed
    const t = gw.chain.entries.map((e) => e.payload.type);
    assert.ok(t.includes('chat_action') && t.includes('approval_requested'), t.join(','));
    assert.equal(gw.chain.verify().ok, true);
    // model's claim text did not override the verdict
    assert.ok(!/Wiping now/.test(out.actions[0].decision));
  } finally { await stub.close(); }
});

test('propose: policy allow (fs.read) → dispatched with null args', async () => {
  const stub = await startStub((req, res) => { res.end(completion('<action>fs.read:notes/x.md</action>')); });
  const { gw, calls } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('read my note', { session: 'llm-2' });
    assert.equal(out.actions[0].decision, 'allow');
    assert.deepEqual(out.actions[0].result, { path: 'notes/x.md', content: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args, null, 'brain carries no args — tool name only');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'chat_action_executed' && e.payload.ok === true));
    assert.equal(gw.chain.verify().ok, true);
  } finally { await stub.close(); }
});

test('propose: unknown tool fails CLOSED into approval (never allow)', async () => {
  const stub = await startStub((req, res) => { res.end(completion('<action>banana_stand</action>')); });
  const { gw, calls } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('peel it', { session: 'llm-3' });
    assert.equal(out.actions[0].decision, 'needs_approval');
    assert.equal(out.actions[0].class, undefined); // action keeps {id,tool,decision,reason,...}
    assert.equal(calls.length, 0);
    const audit = gw.chain.entries.find((e) => e.payload.type === 'chat_action');
    assert.equal(audit.payload.class, 'destructive', 'unknown classifies destructive (fail closed)');
  } finally { await stub.close(); }
});

// ── no-args-leak-to-audit ─────────────────────────────────────────

test('audit: no args, no junk-in-tag secrets, no bearer key anywhere in chain', async () => {
  const stub = await startStub((req, res) => {
    res.end(completion('fixing <action>shell.run --cmd="export PK=${hunter2secret}"; rm -rf /"</action> done'));
  });
  const { gw } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('cleanup', { session: 'llm-4' });
    assert.equal(out.actions[0].tool, 'shell.run', 'only the tool name survives');
    const j = auditJson(gw);
    for (const forbidden of ['hunter2secret', '--cmd', 'rm -rf', 'PK=', KEY]) {
      assert.ok(!j.includes(forbidden), `audit must not contain ${forbidden}`);
    }
    const audit = gw.chain.entries.find((e) => e.payload.type === 'chat_action');
    assert.equal(audit.payload.argsLength, 0);
    assert.ok(!('args' in audit.payload), 'no raw args field at all');
    // parked approval carries no args either
    const parked = gw.approvals.listPending()[0];
    assert.equal(parked.args, null);
    // and the HTTP response body does not leak the key either
    assert.ok(!JSON.stringify(out).includes(KEY));
  } finally { await stub.close(); }
});

test('upstream 5xx: fallback response, key not in output', async () => {
  const stub = await startStub((req, res) => { res.writeHead(500); res.end('boom'); });
  const { gw, calls } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('anything', { session: 'llm-5' });
    assert.equal(out.fallback, true);
    assert.equal(out.error, 'llm_http_error');
    assert.equal(out.actions.length, 0);
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(out).includes(KEY));
  } finally { await stub.close(); }
});

// ── empty response ────────────────────────────────────────────────

test('empty model response → clean fallback, zero actions', async () => {
  const stub = await startStub((req, res) => { res.end(completion('   ')); });
  const { gw, calls } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('hello?', { session: 'llm-6' });
    assert.equal(out.fallback, true);
    assert.equal(out.error, 'llm_empty_response');
    assert.ok(typeof out.reply === 'string' && out.reply.length > 0);
    assert.equal(out.actions.length, 0);
    assert.equal(calls.length, 0);
  } finally { await stub.close(); }
});

test('reply with no action tag → text only, no chat_action audit', async () => {
  const stub = await startStub((req, res) => { res.end(completion('The capital of France is Paris.')); });
  const { gw } = makeGw();
  try {
    const out = await brainFor(gw, stub.url).propose('capital of france?', { session: 'llm-7' });
    assert.equal(out.reply, 'The capital of France is Paris.');
    assert.equal(out.actions.length, 0);
    assert.ok(!gw.chain.entries.some((e) => e.payload.type === 'chat_action'));
  } finally { await stub.close(); }
});

// ── timeout ───────────────────────────────────────────────────────

test('timeout: never-responding upstream → fallback llm_timeout (fast)', async () => {
  const stub = await startStub(() => { /* hold the socket open, never reply */ });
  const { gw, calls } = makeGw();
  try {
    const brain = brainFor(gw, stub.url, { timeoutMs: 150 });
    const t0 = Date.now();
    const out = await brain.propose('hello?', { session: 'llm-8' });
    assert.ok(Date.now() - t0 < 2000, 'must fail fast on timeout');
    assert.equal(out.fallback, true);
    assert.equal(out.error, 'llm_timeout');
    assert.equal(out.actions.length, 0);
    assert.equal(calls.length, 0);
  } finally { await stub.close(); }
});

// ── mount over real HTTP ──────────────────────────────────────────

test('mount: /v2/chat/llm registered on the gateway mount runner', () => {
  const { gw } = makeGw();
  assert.ok(gw.mounts.some((m) => m.name === 'chat-llm' && m.path === '/v2/chat/llm' && m.auth === 'bearer'));
});

test('mount: no bearer token → 401 (audited auth_rejected)', async () => {
  const { gw } = makeGw();
  const front = await startGateway(gw);
  try {
    const res = await postLlm(front.base, { session: 'm1', message: 'hi' }, null);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'auth_rejected'));
  } finally { await front.close(); }
});

test('mount: env unset → 200 with {fallback:true, reply} (no network, no crash)', async () => {
  const saved = { ...process.env };
  delete process.env.TG_LLM_BASE_URL; delete process.env.TG_LLM_KEY; delete process.env.TG_LLM_MODEL;
  const { gw } = makeGw(); // fresh instance → fresh WeakMap brain from (empty) env
  const front = await startGateway(gw);
  try {
    const res = await postLlm(front.base, { session: 'm2', message: 'status?' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fallback, true);
    assert.equal(typeof body.reply, 'string');
    assert.match(body.reply, /TG_LLM/);
    assert.deepEqual(body.actions, []);
    assert.ok(gw.chain.entries.every((e) => e.payload.type === 'genesis'), 'fallback turn makes no stateful decisions');
  } finally {
    await front.close();
    for (const k of ['TG_LLM_BASE_URL', 'TG_LLM_KEY', 'TG_LLM_MODEL']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
});

test('mount e2e: real HTTP → stub upstream → destructive proposal parks for approval', async () => {
  const stub = await startStub((req, res) => { res.end(completion('I will delete it <action>fs.delete:prod</action>')); });
  const { gw, calls } = makeGw();
  setBrain(gw, brainFor(gw, stub.url));
  const front = await startGateway(gw);
  try {
    const res = await postLlm(front.base, { session: 'm3', message: 'delete prod please' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actions[0].decision, 'needs_approval');
    assert.match(body.reply, /fs\.delete:prod/);
    assert.equal(calls.length, 0);
    assert.equal(gw.approvals.listPending().length, 1);
    assert.equal(gw.chain.verify().ok, true);
    // operator approves via the normal v1 flow → now it executes (policy allow after approval)
    const id = body.actions[0].approvalId;
    const ap = await fetch(`${front.base}/v1/approvals/${id}/approve`, {
      method: 'POST', headers: { authorization: 'Bearer tok-atlas' }, body: '{}',
    });
    assert.equal(ap.status, 200);
    assert.equal(calls.length, 1, 'executed exactly once, after approval');
    assert.equal(stub.seen.length, 1, 'upstream consulted once only');
  } finally { await front.close(); await stub.close(); }
});

test('mount: validation 400s (invalid json, missing message)', async () => {
  const stub = await startStub((req, res) => { res.end(completion('ok')); });
  const { gw } = makeGw();
  setBrain(gw, brainFor(gw, stub.url));
  const front = await startGateway(gw);
  try {
    const bad = await fetch(`${front.base}/v2/chat/llm`, {
      method: 'POST', headers: { authorization: 'Bearer tok-forge' }, body: 'nope',
    });
    assert.equal(bad.status, 400);
    const noMsg = await postLlm(front.base, { session: 'm4' });
    assert.equal(noMsg.status, 400);
    const noSess = await postLlm(front.base, { message: 'hi' });
    assert.equal(noSess.status, 400);
  } finally { await front.close(); await stub.close(); }
});
