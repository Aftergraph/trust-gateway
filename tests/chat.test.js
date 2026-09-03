'use strict';
// Tests for the deterministic chat planner (orchestrator-built slice).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Gateway } = require('../src/gateway/server');
const { getPlanner } = require('../src/gateway/chat-singleton');

function makeGw() {
  return new Gateway({
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => {
      if (tool.startsWith('fs.read:')) return { path: tool.slice(8), content: null };
      if (tool.startsWith('fs.write:')) return { wrote: tool.slice(9), bytes: 0 };
      if (tool === 'shell.run') return { ran: args.cmd, echoed: true };
      if (tool.startsWith('fs.delete:')) throw new Error('escapes_jail');
      return { ok: true };
    },
  });
}

function reqRes(method, url, body, token) {
  const req = new EventEmitter();
  req.method = method; req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  if (body) process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return { req, res, status: () => res.status, json: () => JSON.parse(res.body) };
}

test('chat: read is proposed+allowed+dispatched', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's1', message: 'read notes/x.md' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  assert.equal(r.status(), 200);
  const body = r.json();
  assert.equal(body.actions[0].decision, 'allow');
  assert.ok(body.actions[0].result.path);
});

test('chat: destructive proposal goes to approval + audit', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's2', message: 'delete the staging db' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  const body = r.json();
  assert.equal(body.actions[0].decision, 'needs_approval');
  assert.match(body.actions[0].approvalId, /^apr_/);
  // approval visible in pending
  assert.equal(gw.approvals.listPending().length, 1);
  // audit has chat_action + approval_requested and chain verifies
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'chat_action'));
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'approval_requested'));
  assert.equal(gw.chain.verify().ok, true);
});

test('chat: approved proposal executes end-to-end', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's3', message: 'run deploy.sh --prod' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  const id = r.json().actions[0].approvalId;
  const a = reqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-atlas');
  await gw.handle(a.req, a.res);
  assert.equal(a.status(), 200);
  assert.deepEqual(a.json().result, { ran: 'deploy.sh --prod', echoed: true });
});

test('chat: status command reports chain', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's4', message: 'status' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  assert.match(r.json().reply, /SEALED/);
  assert.equal(r.json().actions.length, 0);
});

test('chat: gibberish → fallback, zero actions', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's5', message: 'qwertyuiop asdf' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  assert.equal(r.json().actions.length, 0);
});

test('chat: sessions persist turns', async () => {
  const gw = makeGw();
  const p = getPlanner(gw);
  await p.plan('s6', 'help', 'forge');
  await p.plan('s6', 'status', 'forge');
  const s = p.listSessions().find((x) => x.name === 's6');
  assert.equal(s.turns, 2);
});

test('chat: unknown bot → error reply, no crash', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's7', message: 'status', bot: 'ghost' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  assert.equal(r.status(), 200);
  assert.match(r.json().reply, /unknown bot/);
});

test('chat: jail violation → audited error result, no crash', async () => {
  const gw = makeGw();
  const r = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's8', message: 'delete ../etc/passwd' }), 'tok-forge');
  await gw.handle(r.req, r.res);
  const body = r.json();
  assert.equal(r.status(), 200);
  assert.equal(body.actions[0].decision, 'needs_approval'); // delete is destructive → approval
  // approve it: dispatch must fail but the gateway survives + audits the failure
  const id = body.actions[0].approvalId;
  const a = reqRes('POST', `/v1/approvals/${id}/approve`, '{}', 'tok-atlas');
  await gw.handle(a.req, a.res);
  assert.equal(a.status(), 502); // dispatch failed (escapes_jail) — gateway survives
  assert.equal(a.json().error, 'dispatch_failed');
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'approval_resolved'));
  assert.ok(gw.chain.entries.some((e) => e.payload.type === 'action_executed_after_approval' && e.payload.ok === false));
  assert.equal(gw.chain.verify().ok, true);
});

test('chat: validation 400s', async () => {
  const gw = makeGw();
  const noMsg = reqRes('POST', '/v2/chat', JSON.stringify({ session: 's9' }), 'tok-forge');
  await gw.handle(noMsg.req, noMsg.res);
  assert.equal(noMsg.status(), 400);
  const badJson = reqRes('POST', '/v2/chat', 'nope', 'tok-forge');
  await gw.handle(badJson.req, badJson.res);
  assert.equal(badJson.status(), 400);
});

// ── registerTurn unit tests ────────────────────────────────────

test('chat: registerTurn creates session entry on first write', async () => {
  const gw = makeGw();
  const p = getPlanner(gw);
  p.registerTurn('sess-new', {role: 'user', text: 'hello', bot: 'forge', source: 'chat'});
  const sessions = p.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'sess-new');
  assert.equal(sessions[0].turns, 1);
});

test('chat: registerTurn appends turns idempotently per session', async () => {
  const gw = makeGw();
  const p = getPlanner(gw);
  p.registerTurn('s-multi', {role: 'user', text: 'hello', bot: 'forge', source: 'chat'});
  p.registerTurn('s-multi', {role: 'assistant', text: 'hi there', actions: [], bot: 'forge', source: 'chat'});
  p.registerTurn('s-multi', {role: 'user', text: 'how are you?', bot: 'forge', source: 'chat'});
  const s = p.sessions.get('s-multi');
  assert.equal(s.history.length, 3);
  assert.equal(s.history[0].role, 'user');
  assert.equal(s.history[1].role, 'assistant');
  assert.equal(s.history[2].role, 'user');
});

test('chat: registerTurn stores governance summary (tool+decision), never raw args/results', async () => {
  const gw = makeGw();
  const p = getPlanner(gw);
  const action = { id: 'act_1', tool: 'fs.read:notes/x.md', decision: 'allow', result: { path: 'notes/x.md', content: 'secret' }, error: undefined, approvalId: 'apr_xyz' };
  p.registerTurn('s-gov', {role: 'assistant', text: 'read', actions: [action], bot: 'forge', source: 'llm'});
  const s = p.sessions.get('s-gov');
  assert.equal(s.history.length, 1);
  const turn = s.history[0];
  assert.ok(turn.governance, 'governance summary present');
  assert.deepEqual(turn.governance.tools, ['fs.read:notes/x.md']);
  assert.deepEqual(turn.governance.decisions, ['allow']);
  assert.equal(turn.governance.bot, 'forge');
  assert.equal(turn.governance.source, 'llm');
  // Full result and error must NOT be stored in the turn
  assert.ok(!JSON.stringify(turn).includes('secret'), 'no raw result material in stored turn');
  assert.ok(!JSON.stringify(turn).includes('apr_xyz'), 'no approvalId material in stored turn');
  assert.ok(!JSON.stringify(turn).includes('tok-forge'), 'no bot token in stored turn');
  // Governance summary is present in the governance field, not in text
  assert.ok(turn.governance.tools.includes('fs.read:notes/x.md'), 'governance has tool name');
  assert.ok(turn.governance.decisions.includes('allow'), 'governance has decision');
  // The stored turn should not include the full result object or raw args
  assert.ok(!turn.text.includes('secret'), 'turn text has no raw result');
});

test('chat: registerTurn bounds history by maxTurns', async () => {
  const gw = makeGw();
  const p = getPlanner(gw);
  // maxTurns is 50, history cap is maxTurns * 2 = 100
  for (let i = 0; i < 120; i++) {
    p.registerTurn('s-bounded', {role: i % 2 === 0 ? 'user' : 'assistant', text: `turn-${i}`, actions: [], bot: 'forge', source: 'chat'});
  }
  const s = p.sessions.get('s-bounded');
  assert.ok(s.history.length <= 100, `history bounded to 100, got ${s.history.length}`);
  // listSessions still works; turns counts user turns in the bounded history
  const sessions = p.listSessions();
  assert.equal(sessions.length, 1);
  // After 120 alternating turns capped to 100, the first 20 (10 user+10 assistant) are dropped
  assert.ok(sessions[0].turns <= 60, `turns should be bounded, got ${sessions[0].turns}`);
});
