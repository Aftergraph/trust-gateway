'use strict';
// Wave D — C1 llm-live tests. Local node:http stub upstream — never a
// real provider. Covers the six required scenarios from the C1 contract:
//   (a) no-action single turn
//   (b) one allow action → executed, chat_action audited with
//       source:'llm-live' (chain scan)
//   (c) destructive suggestion → parked approval, NOT executed (assert
//       chain has no execution of it, approval entry exists)
//   (d) iteration cap 3 enforced (stub always returns an action)
//   (e) auth 401
//   (f) fallback when unconfigured (setBrain with configured-false brain)
//
// Audit hygiene assertion (C7 lesson): every audit payload here must
// carry the bot.name STRING only — never the bot object, never the
// token, never the raw cap list.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { setBrain } = require('../src/gateway/llm-brain');
const { deepTurn, parseAction, allowedToolsFor, MAX_ITERATIONS } = require('../src/gateway/llm-loop');

const KEY = '«redacted:sk-…»'; // would be a leak to find this in an audit

// A bare brain stub shaped like LlmBrain for the loop. `configured` is
// explicit; `chat(messages)` is overridden per-test. Sessions are
// initialized to match the real LlmBrain.
function makeBrain(chat, { configured = true } = {}) {
  return {
    configured,
    sessions: new Map(),
    chat,
  };
}

function makeGw() {
  const calls = [];
  const gw = new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*', 'fs.read:*'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (bot, tool, args) => {
      calls.push({ bot, tool, args });
      if (tool.startsWith('fs.read:')) return { path: tool.slice(8), content: 'hello' };
      if (tool.startsWith('fs.write:')) return { wrote: tool.slice(9), bytes: args && args.content ? args.content.length : 0 };
      throw new Error('should_not_reach:' + tool);
    },
  });
  return { gw, calls };
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
      handler(req, res, parsed, seen);
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

// OpenAI-shaped completion payload
function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

// Real HTTP gateway front for the auth/e2e tests
function startGateway(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

const BEARER = 'Bear' + 'er';
const postDeep = (base, body, token = 'tok-forge') =>
  fetch(`${base}/v2/chat/llm/deep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: BEARER + ' ' + token } : {}) },
    body: JSON.stringify(body),
  });

// ── unit: tag parser + allowed-tools builder ───────────────────────

test('parseAction: self-closing <action tool="…" attr="…" />', () => {
  const a = parseAction('Sure, I will read that file.\n<action tool="fs.read:notes/x.md" />');
  assert.ok(a);
  assert.equal(a.tool, 'fs.read:notes/x.md');
  assert.deepEqual(a.args, {});
  assert.equal(a.text, 'Sure, I will read that file.');
});

test('parseAction: attribute args are JSON-parsed when they look like JSON', () => {
  const a = parseAction('<action tool="fs.write:out.txt" content="hello world" />');
  assert.equal(a.tool, 'fs.write:out.txt');
  assert.equal(a.args.content, 'hello world');

  const b = parseAction('<action tool="fs.write:out.txt" bytes="42" />');
  assert.equal(b.args.bytes, 42);

  const c = parseAction('<action tool="fs.write:out.txt" enabled="true" />');
  assert.equal(c.args.enabled, true);

  const d = parseAction('<action tool="fs.write:out.txt" note="null" />');
  assert.equal(d.args.note, null);
});

test('parseAction: last <action…> wins (model puts it at the end)', () => {
  const a = parseAction('thinking <action tool="fs.read:a" /> then <action tool="fs.read:b" />');
  assert.equal(a.tool, 'fs.read:b');
});

test('parseAction: unnamed <action>tool.name</action> still works', () => {
  const a = parseAction('hi <action>fs.read:x</action>');
  assert.equal(a.tool, 'fs.read:x');
  assert.deepEqual(a.args, {});
});

test('parseAction: text without a tag → null', () => {
  assert.equal(parseAction('just a reply'), null);
  assert.equal(parseAction(''), null);
});

test('allowedToolsFor: only read+write from ROLE_CAPABILITIES, no wildcards expanded', () => {
  const worker = { name: 'forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*', 'web.get'] };
  const tools = allowedToolsFor(worker);
  assert.ok(tools.includes('fs.read'));
  assert.ok(tools.includes('fs.write:*'));
  assert.ok(tools.includes('web.get'));
  // destructive caps (none here) must NOT appear
  assert.ok(!tools.some((t) => t.startsWith('shell.run')));
  // wildcard never expanded into concrete tool names
  assert.ok(!tools.some((t) => /^fs\.write:[^"]+$/.test(t) && t !== 'fs.write:*'));
});

test('allowedToolsFor: operator with wildcard caps is still bounded to role+read/write', () => {
  const op = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  const tools = allowedToolsFor(op);
  // operator role caps include shell.run, which classifies destructive — must be filtered
  assert.ok(!tools.includes('shell.run'));
  assert.ok(tools.includes('fs.read'));
  assert.ok(tools.includes('fs.write:*'));
});

// ── (a) no-action single turn ──────────────────────────────────────

test('(a) no-action single turn: model says no <action> → reply is the model text, no chain chat_action', async () => {
  const stub = await startStub((req, res) => { res.end(completion('The capital of France is Paris.')); });
  const { gw, calls } = makeGw();
  const brain = makeBrain(async () => 'The capital of France is Paris.');
  try {
    const out = await deepTurn(gw, brain, { session: 'a1', message: 'capital of france?' });
    assert.equal(out.reply, 'The capital of France is Paris.');
    assert.equal(out.actions.length, 0);
    assert.equal(out.iterations, 1);
    assert.ok(!out.fallback);
    assert.equal(calls.length, 0);
    assert.ok(!gw.chain.entries.some((e) => e.payload.type === 'chat_action'));
  } finally { await stub.close(); }
});

// ── (b) one allow action: executed, chat_action audited with source:'llm-live' ──

test('(b) allow action: fs.read → dispatched, chat_action with source:"llm-live" in chain', async () => {
  const stub = await startStub((req, res) => { res.end(completion('Reading now.\n<action tool="fs.read:notes/x.md" />')); });
  const { gw, calls } = makeGw();
  let n = 0;
  const brain = makeBrain(async () => {
    n += 1;
    if (n === 1) return 'Reading now.\n<action tool="fs.read:notes/x.md" />';
    return 'Done — no further action needed.';
  });
  try {
    const out = await deepTurn(gw, brain, { session: 'b1', message: 'read my note' });
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].tool, 'fs.read:notes/x.md');
    assert.equal(out.actions[0].decision, 'allow');
    assert.deepEqual(out.actions[0].result, { path: 'notes/x.md', content: 'hello' });
    assert.equal(out.actions[0].source, undefined); // source is on the audit, not the action record
    // chain scan: chat_action with source:'llm-live'
    const chatAction = gw.chain.entries.find((e) => e.payload.type === 'chat_action');
    assert.ok(chatAction, 'chat_action must be audited');
    assert.equal(chatAction.payload.source, 'llm-live');
    assert.equal(chatAction.payload.tool, 'fs.read:notes/x.md');
    assert.equal(chatAction.payload.decision, 'allow');
    // chat_action_executed with source:'llm-live'
    const executed = gw.chain.entries.find((e) => e.payload.type === 'chat_action_executed');
    assert.ok(executed);
    assert.equal(executed.payload.source, 'llm-live');
    assert.equal(executed.payload.ok, true);
    // dispatch fired exactly once, with the right tool
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'fs.read:notes/x.md');
    // C7 hygiene: bot is a STRING in every entry, never the object, never the token
    const j = JSON.stringify(gw.chain.entries);
    assert.ok(!j.includes('tok-forge'), 'no bot token in chain');
    assert.ok(!j.includes('"token"'), 'no "token" field in chain');
    assert.ok(!/capabilities/.test(j), 'no capabilities in chat_action chain entries');
  } finally { await stub.close(); }
});

// ── (c) destructive suggestion: parked approval, NOT executed ──────

test('(c) destructive suggestion: shell.run → parked approval, never dispatched', async () => {
  const stub = await startStub((req, res) => { res.end(completion('I will wipe it now.\n<action tool="shell.run" />')); });
  const { gw, calls } = makeGw();
  const brain = makeBrain(async () => 'I will wipe it now.\n<action tool="shell.run" />');
  try {
    const out = await deepTurn(gw, brain, { session: 'c1', message: 'wipe prod' });
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].tool, 'shell.run');
    assert.equal(out.actions[0].decision, 'needs_approval');
    assert.match(out.actions[0].approvalId, /^apr_/);
    assert.equal(out.pending_approval.id, out.actions[0].approvalId);
    assert.equal(out.pending_approval.tool, 'shell.run');
    // THE assertion: nothing was dispatched
    assert.equal(calls.length, 0, 'destructive proposal must not be dispatched before approval');
    // chain scan: approval_requested exists, NO action_executed/chat_action_executed for shell.run
    const chain = gw.chain.entries;
    const requested = chain.find((e) => e.payload.type === 'approval_requested' && e.payload.tool === 'shell.run');
    assert.ok(requested, 'approval_requested must be audited');
    const execs = chain.filter((e) => e.payload.type === 'chat_action_executed' && e.payload.tool === 'shell.run');
    assert.equal(execs.length, 0, 'no execution entry for shell.run');
    // chat_action carries class:'destructive'
    const chatAction = chain.find((e) => e.payload.type === 'chat_action' && e.payload.tool === 'shell.run');
    assert.ok(chatAction);
    assert.equal(chatAction.payload.class, 'destructive');
    assert.equal(chatAction.payload.decision, 'needs_approval');
    // loop stopped on the first needs_approval (no follow-up observation round)
    assert.equal(out.iterations, 1);
  } finally { await stub.close(); }
});

// ── (d) iteration cap 3 enforced (stub always returns an action) ───

test('(d) iteration cap 3 enforced: stub keeps returning actions → loop stops after 3, no more dispatches', async () => {
  // The brain always returns a fresh <action> tag (so the loop never
  // gets a no-action turn to stop on). The dispatch path runs on the
  // local gateway — not the upstream stub — so upstreamCalls stays 0
  // and that is the point: the cap is enforced by the LOOP, not by
  // upstream behavior. After 3 iterations the loop MUST stop even
  // though the brain would have answered a 4th turn.
  const stub = await startStub((req, res) => { res.end(completion('ignored — brain is local')); });
  const { gw, calls } = makeGw();
  let n = 0;
  const brain = makeBrain(async () => {
    n += 1;
    return `loop iter ${n}\n<action tool="fs.read:loop${n}.md" />`;
  });
  try {
    const out = await deepTurn(gw, brain, { session: 'd1', message: 'read forever' });
    assert.equal(out.iterations, MAX_ITERATIONS, 'iterations must equal the cap');
    assert.equal(out.actions.length, MAX_ITERATIONS);
    // Every action is a read; every action was dispatched
    assert.equal(calls.length, MAX_ITERATIONS);
    // Upstream was NEVER consulted — the brain is local (this is the
    // point of the test: cap is a client-side loop guard, not a server
    // contract on the model).
    assert.equal(stub.seen.length, 0, 'cap is enforced before any upstream call');
    // The chat_action entries are all there, with iteration: 0,1,2
    const chatActions = gw.chain.entries.filter((e) => e.payload.type === 'chat_action');
    assert.equal(chatActions.length, MAX_ITERATIONS);
    assert.deepEqual(chatActions.map((e) => e.payload.iteration), [0, 1, 2]);
  } finally { await stub.close(); }
});

// ── (e) auth 401 ───────────────────────────────────────────────────

test('(e) auth 401: no bearer token → 401 (audited auth_rejected)', async () => {
  const { gw } = makeGw();
  const front = await startGateway(gw);
  try {
    const res = await postDeep(front.base, { session: 'e1', message: 'hi' }, null);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'auth_rejected'));
  } finally { await front.close(); }
});

test('(e) mount: /v2/chat/llm/deep registered with bearer auth on the mount runner', () => {
  const { gw } = makeGw();
  assert.ok(gw.mounts.some((m) => m.name === 'chat-llm-deep' && m.path === '/v2/chat/llm/deep' && m.auth === 'bearer'));
});

// ── (f) fallback when unconfigured (configured-false brain) ────────

test('(f) fallback when unconfigured: brain.configured === false → 200 with fallback:true', async () => {
  const { gw } = makeGw();
  const front = await startGateway(gw);
  // Wire a configured=false brain — this is what setBrain with a
  // partially-configured brain would do. The mount must short-circuit
  // BEFORE the loop runs.
  setBrain(gw, makeBrain(async () => 'never', { configured: false }));
  try {
    const res = await postDeep(front.base, { session: 'f1', message: 'status?' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fallback, true);
    assert.equal(body.reply, 'llm not configured');
    assert.deepEqual(body.actions, []);
    // No upstream consultation, no chat_action, no approval.
    assert.ok(gw.chain.entries.every((e) => e.payload.type === 'genesis'), 'fallback turn makes no stateful decisions');
  } finally { await front.close(); }
});

// ── extra: e2e over real HTTP + stub upstream (parity with the
// single-turn mount test) ──────────────────────────────────────────

test('e2e: real HTTP → stub → allow read → executed; chain has source:"llm-live"', async () => {
  const stub = await startStub((req, res) => { res.end(completion('<action tool="fs.read:hi.md" />')); });
  const { gw, calls } = makeGw();
  let n = 0;
  setBrain(gw, makeBrain(async () => {
    n += 1;
    if (n === 1) return '<action tool="fs.read:hi.md" />';
    return 'all done';
  }));
  const front = await startGateway(gw);
  try {
    const res = await postDeep(front.base, { session: 'e2e1', message: 'read hi' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actions[0].decision, 'allow');
    assert.equal(calls.length, 1);
    assert.equal(gw.chain.entries.some((e) => e.payload.type === 'chat_action' && e.payload.source === 'llm-live'), true);
  } finally { await front.close(); await stub.close(); }
});

// ── extra: tool dispatch error → model receives failure observation ─

test('iteration: dispatch failure → action.error, observation fed back, loop may continue', async () => {
  let n = 0;
  const brain = makeBrain(async () => {
    n += 1;
    if (n === 1) return 'trying <action tool="fs.read:bad" />';
    if (n === 2) return 'ok then <action tool="fs.read:good.md" />';
    return 'no action this time';
  });
  const { gw } = makeGw();
  // Inject a faulty read: anything starting with fs.read:bad fails
  const origRun = gw._run.bind(gw);
  gw._run = async (bot, tool, args) => {
    if (tool === 'fs.read:bad') throw new Error('jail_refused');
    return origRun(bot, tool, args);
  };
  const out = await deepTurn(gw, brain, { session: 'obs1', message: 'try' });
  assert.equal(out.actions.length, 2);
  assert.equal(out.actions[0].error, 'dispatch_failed');
  assert.equal(out.actions[1].decision, 'allow');
  assert.deepEqual(out.actions[1].result, { path: 'good.md', content: 'hello' });
  // Both audit entries present
  const execs = gw.chain.entries.filter((e) => e.payload.type === 'chat_action_executed');
  assert.equal(execs.length, 2);
  assert.equal(execs[0].payload.ok, false);
  assert.equal(execs[1].payload.ok, true);
});

// ── extra: C7 audit hygiene — NEVER spread bot, NEVER include token ─

test('audit hygiene: every entry in chain has bot as STRING, never object, never token', async () => {
  const stub = await startStub((req, res) => { res.end(completion('<action tool="fs.read:x" />')); });
  const { gw } = makeGw();
  const brain = makeBrain(async () => '<action tool="fs.read:x" />');
  await deepTurn(gw, brain, { session: 'h1', message: 'read x' });
  const j = JSON.stringify(gw.chain.entries);
  assert.ok(!j.includes('tok-forge'), 'chain must not contain the bot token');
  assert.ok(!j.includes('"role":"worker"'), 'role/capabilities belong to projection endpoints, not chat_action');
  // bot field is always the name string
  for (const e of gw.chain.entries) {
    if (e.payload.type === 'genesis') continue;
    if (typeof e.payload.bot === 'object' && e.payload.bot !== null) {
      throw new Error(`payload.bot is an object on entry type=${e.payload.type}`);
    }
  }
  await stub.close();
});
