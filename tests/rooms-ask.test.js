'use strict';
// A1 TDD — Rooms ↔ LLM-kobling ("spørg hjernen" i tråden).
//
// Ny mount: POST /v2/rooms/:id/ask
//   body: { message }  (acting bot = room member; session = room-scoped)
// Behavior contract:
//   1. Room must exist and acting bot must be a member (else 403/404).
//   2. Delegates the turn to the SAME governed brain (getBrain(gw).propose)
//      with a room-namespaced session `room_<roomId>` (per-gateway map).
//   3. The user's question AND the assistant's answer are both appended to
//      the room transcript as A2A envelopes:
//        { from: <bot>, kind: 'message', body: <question> }
//        { from: <bot>, kind: 'assistant', body: <reply>,
//          proposal: <proposal|null>, fallback?: true }
//      'assistant' is a NEW room kind — rooms store extended (additive).
//   4. Fallback (brain not configured) → still posts the envelope with
//      fallback:true and a deterministic reply; never 5xx.
//   5. Non-operator users hitting /v2/chat/llm/user rate limits are NOT
//      involved here: room ask is bearer-bot auth (the mount runner's
//      ctx.bot) — the console posts as its own bot.
//   6. Audit: room_ask {roomId, bot, fallback} — never message text.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TG_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-ask-')), 'gateway.db');
process.env.TG_ROOMS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rooms-file-')), 'rooms.json');
process.env.TG_AIE_FAIL_OPEN = 'true';

const { Gateway } = require('../src/gateway/server');

function makeGateway(opts = {}) {
  return new Gateway({
    port: 0,
    bots: { op: { token: 'tok-op', role: 'operator', capabilities: ['*'] } },
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/25-groups.js'), require('../src/gateway/mounts/146-rooms-ask.js')],
    ...opts,
  });
}

function req(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function boot(gw) {
  const server = http.createServer((req2, res) => gw.handle(req2, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, port };
}

test('rooms ask: mount registered with POST /v2/rooms/:id/ask', () => {
  const m = require('../src/gateway/mounts/146-rooms-ask.js');
  assert.equal(m.method, 'POST');
  const src = m.path instanceof RegExp ? m.path.source : String(m.path);
  assert.ok(src.includes('v2') && src.includes('rooms'), 'path targets rooms');
  assert.ok(src.includes('ask'), 'path targets ask');
});

test('rooms ask: 404 for unknown room', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const r = await req(port, 'POST', '/v2/rooms/room_nope/ask', 'tok-op', { message: 'hi' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  } finally { await new Promise((r) => server.close(r)); }
});

test('rooms ask: happy path posts question + assistant envelope to transcript (fallback brain)', async () => {
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'helpdesk', bots: ['op'] });
    assert.equal(c.status, 201, 'room create');
    const roomId = c.body.room.id;

    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-op', { message: 'status?' });
    assert.equal(a.status, 200, `ask status: ${JSON.stringify(a.body)}`);
    assert.equal(a.body.ok, true);
    assert.equal(typeof a.body.reply, 'string');
    // fallback brain (no TG_LLM_KEY) → fallback flag, deterministic reply
    assert.equal(a.body.fallback, true);

    // transcript now has the question + assistant envelope
    const d = await req(port, 'GET', `/v2/rooms/${roomId}`, 'tok-op');
    const msgs = (d.body.room && d.body.room.messages) || [];
    const kinds = msgs.map((m) => m.kind);
    assert.ok(kinds.includes('assistant'), `assistant envelope in transcript: ${JSON.stringify(kinds)}`);
    const asst = msgs.find((m) => m.kind === 'assistant');
    assert.equal(asst.body, a.body.reply);
    assert.equal(asst.fallback, true);
  } finally { await new Promise((r) => server.close(r)); }
});

test('rooms ask: brain reply is governed — proposal surfaces in envelope when model proposes', async () => {
  // Inject a stub brain so we can prove the proposal passes through.
  const gw = makeGateway();
  const { server, port } = await boot(gw);
  try {
    const { getBrain } = require('../src/gateway/llm-brain');
    const brain = getBrain(gw);
    const orig = brain.propose ? brain.propose.bind(brain) : null;
    brain.propose = async (message, opts) => ({
      reply: 'I can delete that file.',
      proposal: { tool: 'fs.delete:tmp/x', decision: 'pending' },
    });

    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'gov', bots: ['op'] });
    const roomId = c.body.room.id;
    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-op', { message: 'delete tmp/x' });
    assert.equal(a.status, 200);
    assert.equal(a.body.fallback, undefined); // real brain path (stub)
    assert.ok(a.body.proposal, 'proposal surfaced');

    const d = await req(port, 'GET', `/v2/rooms/${roomId}`, 'tok-op');
    const msgs = (d.body.room && d.body.room.messages) || [];
    const asst = msgs.find((m) => m.kind === 'assistant');
    assert.deepEqual(asst.proposal, { tool: 'fs.delete:tmp/x', decision: 'pending' });

    if (orig) brain.propose = orig;
  } finally { await new Promise((r) => server.close(r)); }
});

test('rooms ask: non-member bot gets 403', async () => {
  const gw = new Gateway({
    port: 0,
    bots: {
      op: { token: 'tok-op', role: 'operator', capabilities: ['*'] },
      w: { token: 'tok-w', role: 'worker', capabilities: ['fs.read'] },
    },
    mountFiles: false,
    mounts: [require('../src/gateway/mounts/25-groups.js'), require('../src/gateway/mounts/146-rooms-ask.js')],
  });
  const { server, port } = await boot(gw);
  try {
    const c = await req(port, 'POST', '/v2/rooms', 'tok-op', { name: 'closed', bots: ['op'] });
    const roomId = c.body.room.id;
    const a = await req(port, 'POST', `/v2/rooms/${roomId}/ask`, 'tok-w', { message: 'hi' });
    assert.equal(a.status, 403);
    assert.equal(a.body.error, 'not_member');
  } finally { await new Promise((r) => server.close(r)); }
});
