'use strict';
// W2 group rooms — tests.
// Covers: RoomStore durability (atomic 0600, fail-closed, reload), caps
// (msgCap + turnLimit) enforced with room_limit_hit audits, bot-mention
// fan-out, verified handoff chains, proposal routing through classify/decide
// + approvals, cross-room isolation, SSE hub.broadcast('room'), the
// GET/POST/DELETE /v2/rooms mounts over real HTTP, and chain verification.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Gateway } = require('../src/gateway/server');
const { getHub } = require('../src/gateway/events');
const { ApprovalStore } = require('../src/gateway/approvals');
const { RoomStore, getRoomStore, DEFAULT_TURN_LIMIT, DEFAULT_MSG_CAP, MAX_HANDOFF_DEPTH } = require('../src/gateway/groups');

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rooms-')), name);
}

function fakeGateway() {
  const audits = [];
  const dispatched = [];
  return {
    audits,
    dispatched,
    bots: {
      forge: { token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      atlas: { token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      scribe: { token: 'tok-scribe', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
    },
    approvals: new ApprovalStore(),
    dispatch: async (bot, tool, args) => { dispatched.push({ bot, tool, args }); return { ran: tool }; },
    _audit(payload) { audits.push(payload); return { payload }; },
  };
}

function auditTypes(store) {
  return store.gateway ? store.gateway.audits.map((a) => a.type) : store.auditTrail.map((a) => a.type);
}

// ── room lifecycle + defaults ─────────────────────────────────────

test('create: defaults turnLimit=3 msgCap=10, stable room_ ids', () => {
  const s = new RoomStore();
  const r1 = s.create({ name: 'launch war room', bots: ['forge', 'atlas'], humans: ['jonas'] });
  const r2 = s.create({ name: 'second', bots: ['forge'] });
  assert.equal(r1.turnLimit, DEFAULT_TURN_LIMIT);
  assert.equal(r1.turnLimit, 3);
  assert.equal(r1.msgCap, DEFAULT_MSG_CAP);
  assert.equal(r1.id, 'room_000001');
  assert.equal(r2.id, 'room_000002');
  assert.deepEqual(r1.members, { bots: ['forge', 'atlas'], humans: ['jonas'] });
});

test('create: rejects bad names, bad limits, duplicate bot/human, unknown bots (fail closed)', () => {
  const s = new RoomStore({ gateway: fakeGateway() });
  assert.throws(() => s.create({ name: '' }), /name_invalid/);
  assert.throws(() => s.create({ name: 'x', turnLimit: 0 }), /limit_must_be_integer/);
  assert.throws(() => s.create({ name: 'x', msgCap: 1.5 }), /limit_must_be_integer/);
  assert.throws(() => s.create({ name: 'x', bots: ['a'], humans: ['a'] }), /member_both_bot_and_human/);
  assert.throws(() => s.create({ name: 'x', bots: ['ghost'] }), /unknown_bot:ghost/);
});

// ── durability ────────────────────────────────────────────────────

test('durable reload: rooms + messages survive, id counter continues, caps still enforced', () => {
  const f = tmpfile('rooms.json');
  const s1 = new RoomStore({ file: f });
  const r = s1.create({ name: 'persisted', bots: ['forge'], humans: ['jonas'], turnLimit: 2, msgCap: 5 });
  return s1.deliver(r.id, { from: 'jonas', body: 'hello room' }).then((out) => {
    assert.ok(out.ok);
    const s2 = new RoomStore({ file: f });
    const loaded = s2.get(r.id);
    assert.ok(loaded, 'room must reload from disk');
    assert.equal(loaded.name, 'persisted');
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].body, 'hello room');
    assert.equal(loaded.turnLimit, 2);
    const r2 = s2.create({ name: 'fresh' });
    assert.equal(r2.id, 'room_000002', 'id counter continues after reload');
  });
});

test('corrupt rooms file → refuse to load (fail closed)', () => {
  const f = tmpfile('rooms.json');
  fs.writeFileSync(f, '{"rooms": [ BROKEN');
  assert.throws(() => new RoomStore({ file: f }), /refusing to load/);
  const f2 = tmpfile('rooms2.json');
  fs.writeFileSync(f2, '[1,2,3]'); // wrong shape: not {rooms:[...]}
  assert.throws(() => new RoomStore({ file: f2 }), /rooms array/);
});

test('atomic write: 0600 mode, no .tmp left behind', async () => {
  const f = tmpfile('rooms.json');
  const s = new RoomStore({ file: f });
  const r = s.create({ name: 'modes', bots: ['forge'] });
  await s.deliver(r.id, { from: 'forge', body: '@forge hi' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(f + '.tmp'));
});

// ── caps ──────────────────────────────────────────────────────────

test('msgCap enforced: limit audited, message NOT persisted, further posts refused', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'tight', bots: ['forge'], humans: ['jonas'], turnLimit: 9, msgCap: 2 });
  assert.ok((await s.deliver(r.id, { from: 'jonas', body: 'm1' })).ok);
  assert.ok((await s.deliver(r.id, { from: 'forge', body: 'm2' })).ok);
  const out = await s.deliver(r.id, { from: 'jonas', body: 'm3' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'msg_cap_reached');
  assert.equal(s.get(r.id).messages.length, 2, 'refused message must not persist');
  assert.ok(auditTypes(s).includes('room_limit_hit'));
  const hit = s.auditTrail.find((p) => p.type === 'room_limit_hit');
  assert.equal(hit.cap, 'msgCap');
  assert.equal(hit.limit, 2);
});

test('turnLimit enforced: bot turns capped, humans unaffected until msgCap', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'turns', bots: ['forge', 'atlas'], humans: ['jonas'], turnLimit: 2, msgCap: 10 });
  assert.ok((await s.deliver(r.id, { from: 'forge', body: 'a' })).ok);
  assert.ok((await s.deliver(r.id, { from: 'atlas', body: 'b' })).ok);
  const denied = await s.deliver(r.id, { from: 'forge', body: 'c' });
  assert.equal(denied.error, 'turn_limit_reached');
  const hit = s.auditTrail.find((p) => p.type === 'room_limit_hit');
  assert.equal(hit.cap, 'turnLimit');
  // human messages are not bot turns
  assert.ok((await s.deliver(r.id, { from: 'jonas', body: 'd' })).ok);
});

// ── fan-out ───────────────────────────────────────────────────────

test('bot-mention fan-out: @mentions + explicit mentions resolve to room bot members only', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'fan', bots: ['forge', 'atlas'], humans: ['jonas'] });
  const out = await s.deliver(r.id, { from: 'jonas', body: 'ping @atlas and @forge (not @nobody)', mentions: ['nobody'] });
  assert.ok(out.ok);
  assert.deepEqual(out.deliveredTo.slice().sort(), ['atlas', 'forge']);
  const hops = s.auditTrail.filter((p) => p.type === 'room_message' && p.kind === 'fanout').map((p) => p.to).sort();
  assert.deepEqual(hops, ['atlas', 'forge'], 'every fan-out hop audited');
});

test('cross-room isolation: mention only reaches bots in THAT room; transcripts stay separate', async () => {
  const s = new RoomStore();
  const rA = s.create({ name: 'A', bots: ['forge', 'atlas'], humans: ['jonas'], turnLimit: 5, msgCap: 20 });
  const rB = s.create({ name: 'B', bots: ['scribe'], humans: ['jonas'], turnLimit: 5, msgCap: 20 });
  const inA = await s.deliver(rA.id, { from: 'jonas', body: 'secret plan @atlas' });
  assert.deepEqual(inA.deliveredTo, ['atlas']);
  // atlas is NOT a member of room B → must not receive anything there
  const inB = await s.deliver(rB.id, { from: 'jonas', body: 'hello @atlas @scribe' });
  assert.deepEqual(inB.deliveredTo, ['scribe'], 'atlas must not be fanned out in room B');
  assert.equal(s.get(rB.id).messages.every((m) => !(m.deliveredTo || []).includes('atlas')), true);
  assert.equal(s.get(rA.id).messages.length, 1, 'room B posts never land in room A');
  assert.equal(s.get(rB.id).messages.length, 1, 'room A posts never land in room B');
});

test('deliver: not_found / not_member / bad_kind / impersonating non-members all refused', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'doors', bots: ['forge'], humans: ['jonas'] });
  assert.equal((await s.deliver('room_999999', { from: 'jonas', body: 'x' })).error, 'not_found');
  assert.equal((await s.deliver(r.id, { from: 'stranger', body: 'x' })).error, 'not_member');
  assert.equal((await s.deliver(r.id, { from: 'jonas', kind: 'shout', body: 'x' })).error, 'bad_kind');
  assert.equal((await s.deliver(r.id, { from: 'jonas', body: '   ' })).error, 'body_must_be_short_string');
  assert.equal(r.messages.length, 0, 'refusals never persist');
});

// ── handoff chains ────────────────────────────────────────────────

test('handoff chain: forge→atlas→scribe verifies against real room history', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'relay', bots: ['forge', 'atlas', 'scribe'], humans: ['jonas'], turnLimit: 5, msgCap: 20 });
  const h1 = await s.deliver(r.id, { from: 'forge', kind: 'handoff', target: 'atlas', chain: ['forge'], body: 'draft then review' });
  assert.ok(h1.ok, JSON.stringify(h1));
  assert.deepEqual(h1.message.chain, ['forge']);
  assert.deepEqual(h1.deliveredTo, ['atlas']);
  const h2 = await s.deliver(r.id, { from: 'atlas', kind: 'handoff', target: 'scribe', chain: ['forge', 'atlas'], body: 'drafted, over to you' });
  assert.ok(h2.ok, JSON.stringify(h2));
  assert.deepEqual(h2.deliveredTo, ['scribe']);
  const hands = s.auditTrail.filter((p) => p.type === 'room_handoff');
  assert.equal(hands.length, 2);
  assert.deepEqual(hands[1].chain, ['forge', 'atlas', 'scribe']);
  assert.equal(hands[1].to, 'scribe');
});

test('handoff chain refusals: fabricated, self, non-member, loop, mis-ordered, too deep', async () => {
  const s = new RoomStore();
  const r = s.create({ name: 'relay2', bots: ['forge', 'atlas', 'scribe'], humans: ['jonas'], turnLimit: 9, msgCap: 30 });
  const base = { from: 'forge', kind: 'handoff', target: 'atlas', body: 'go' };
  // fabricated history: claims scribe already handed to forge (never happened)
  assert.equal((await s.deliver(r.id, { ...base, chain: ['scribe', 'forge'] })).error, 'chain_not_backed_by_room_history');
  // chain must end at the sender
  assert.equal((await s.deliver(r.id, { ...base, chain: ['scribe'] })).error, 'chain_must_end_at_sender');
  // self / non-member / loop
  assert.equal((await s.deliver(r.id, { ...base, target: 'forge' })).error, 'handoff_to_self');
  assert.equal((await s.deliver(r.id, { ...base, target: 'jonas' })).error, 'handoff_target_not_member');
  assert.equal((await s.deliver(r.id, { ...base, target: 'ghost' })).error, 'handoff_target_not_member');
  assert.equal((await s.deliver(r.id, { ...base, chain: ['atlas', 'forge'] })).error, 'handoff_loop');
  // chain links must be room bot members
  assert.equal((await s.deliver(r.id, { ...base, chain: ['ghost', 'forge'] })).error, 'chain_link_not_member');
  // depth cap
  const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'forge'];
  assert.equal(deep.length, MAX_HANDOFF_DEPTH + 1);
  assert.equal((await s.deliver(r.id, { ...base, chain: deep })).error, 'chain_too_deep');
  // human cannot hand off
  assert.equal((await s.deliver(r.id, { from: 'jonas', kind: 'handoff', target: 'atlas', body: 'x' })).error, 'only_bots_can_handoff');
  assert.equal(r.messages.length, 0, 'no refused handoff persisted');
});

// ── proposals: classify/decide + approvals ────────────────────────

test('proposal write-without-cap → needs_approval + parked approval, args NOT in room store', async () => {
  const g = fakeGateway();
  const s = new RoomStore({ gateway: g });
  const r = s.create({ name: 'gov', bots: ['forge'] });
  const out = await s.deliver(r.id, { from: 'forge', kind: 'proposal', body: { tool: 'db.write:ledger', args: { amount: 42, secret: 'top' } } });
  assert.ok(out.ok);
  assert.equal(out.proposal.decision, 'needs_approval');
  assert.equal(out.proposal.class, 'write');
  assert.ok(out.proposal.approvalId, 'approval parked');
  const pending = g.approvals.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'db.write:ledger');
  assert.deepEqual(g.dispatched, [], 'needs_approval must NOT dispatch');
  const types = g.audits.map((a) => a.type);
  assert.ok(types.includes('action_decision') && types.includes('approval_requested'));
});

test('proposal read-with-cap → allow → dispatch exactly once, executed audit', async () => {
  const g = fakeGateway();
  const s = new RoomStore({ gateway: g });
  const r = s.create({ name: 'gov2', bots: ['scribe'] });
  const out = await s.deliver(r.id, { from: 'scribe', kind: 'proposal', body: { tool: 'fs.write:out.txt', args: { content: 'hi' } } });
  assert.equal(out.proposal.decision, 'allow');
  assert.deepEqual(out.proposal.result, { ran: 'fs.write:out.txt' });
  assert.equal(g.dispatched.length, 1);
  const exec = g.audits.find((a) => a.type === 'action_executed');
  assert.equal(exec.ok, true);
});

test('proposal secret-without-cap → deny, nothing dispatched', async () => {
  const g = fakeGateway();
  const s = new RoomStore({ gateway: g });
  const r = s.create({ name: 'gov3', bots: ['forge'] });
  const out = await s.deliver(r.id, { from: 'forge', kind: 'proposal', body: { tool: 'secret.read' } });
  assert.ok(out.ok, 'the proposal message itself is recorded (governed, denied)');
  assert.equal(out.proposal.decision, 'deny');
  assert.deepEqual(g.dispatched, []);
  assert.equal(g.approvals.listPending().length, 0);
});

test('proposal secret hygiene: rooms.json never contains args values', async () => {
  const f = tmpfile('rooms.json');
  const g = fakeGateway();
  const s = new RoomStore({ file: f, gateway: g });
  const r = s.create({ name: 'sec', bots: ['forge'] });
  await s.deliver(r.id, { from: 'forge', kind: 'proposal', body: { tool: 'db.write:x', args: { card: 'SUPER-SECRET-42' } } });
  const onDisk = fs.readFileSync(f, 'utf8');
  assert.ok(!onDisk.includes('SUPER-SECRET'), 'args values must never hit rooms.json');
  assert.ok(onDisk.includes('db.write:x'), 'tool name stays for the transcript');
});

// ── HTTP mount surface ────────────────────────────────────────────

function buildServer() {
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) { gw = gateway; server.on('request', (req, res) => gw.handle(req, res)); },
    close() { return new Promise((r) => server.close(() => r())); },
    gw: () => gw,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      scribe: { name: 'scribe', token: 'tok-scribe', role: 'worker', capabilities: ['fs.read', 'fs.write:*'] },
    },
    dispatch: async (bot, tool, args) => ({ ok: true, bot, tool }),
  });
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

function bearer(tok) { return { authorization: `Bearer ${tok}` }; }

test('mount: /v2/rooms requires bearer auth (401)', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const ctx = buildServer(); ctx.attach(makeGateway());
  const url = await listen(ctx.server);
  try {
    assert.equal((await jfetch(`${url}/v2/rooms`)).status, 401);
    assert.equal((await jfetch(`${url}/v2/rooms`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await jfetch(`${url}/v2/rooms/room_000001`, { method: 'DELETE' })).status, 401);
    assert.equal((await jfetch(`${url}/v2/rooms/room_000001/messages`, { method: 'POST', body: '{}' })).status, 401);
  } finally { await ctx.close(); }
});

test('mount: create → list → transcript → delete lifecycle over real HTTP', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const gw = makeGateway();
  const ctx = buildServer(); ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const created = await jfetch(`${url}/v2/rooms`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'release room', bots: ['forge', 'scribe'], humans: ['jonas'], turnLimit: 4, msgCap: 6 }),
    });
    assert.equal(created.status, 201);
    const roomId = created.body.room.id;
    assert.equal(created.body.room.createdBy, 'atlas');
    assert.ok(created.body.room.members.bots.includes('atlas'), 'creator auto-added');
    assert.equal(created.body.room.turnLimit, 4);
    // token NEVER in any projection
    assert.ok(!JSON.stringify(created.body).includes('tok-'));

    const posted = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'kickoff — @forge status?' }),
    });
    assert.equal(posted.status, 201);
    assert.deepEqual(posted.body.deliveredTo, ['forge']);
    assert.equal(posted.body.message.to, roomId, 'A2A envelope: to=room');
    assert.equal(posted.body.message.kind, 'message');

    const listed = await jfetch(`${url}/v2/rooms`, { headers: bearer('tok-forge') });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.rooms.length, 1);
    assert.equal(listed.body.rooms[0].messageCount, 1);

    const detail = await jfetch(`${url}/v2/rooms/${roomId}`, { headers: bearer('tok-forge') });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.room.messages[0].body, 'kickoff — @forge status?');

    // worker that is not the creator may not delete
    const forbidden = await jfetch(`${url}/v2/rooms/${roomId}`, { method: 'DELETE', headers: bearer('tok-forge') });
    assert.equal(forbidden.status, 403);
    // operator may
    const gone = await jfetch(`${url}/v2/rooms/${roomId}`, { method: 'DELETE', headers: bearer('tok-atlas') });
    assert.equal(gone.status, 200);
    assert.equal((await jfetch(`${url}/v2/rooms/${roomId}`, { headers: bearer('tok-atlas') })).status, 404);
    // chain integrity after the full lifecycle
    assert.equal(gw.chain.verify().ok, true);
    const types = gw.chain.entries.map((e) => e.payload.type);
    for (const t of ['room_created', 'room_message', 'room_deleted']) {
      assert.ok(types.includes(t), `audit chain must contain ${t}`);
    }
  } finally { await ctx.close(); }
});

test('mount: no impersonation — bot posting as someone else → 403', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const ctx = buildServer(); ctx.attach(makeGateway());
  const url = await listen(ctx.server);
  try {
    const created = await jfetch(`${url}/v2/rooms`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'imp', humans: ['jonas'] }),
    });
    const r = await jfetch(`${url}/v2/rooms/${created.body.room.id}/messages`, {
      method: 'POST', headers: { ...bearer('tok-forge'), 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'jonas', body: 'pretending to be human' }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'no_impersonation');
  } finally { await ctx.close(); }
});

test('mount: caps over HTTP → 409 with room_limit_hit audited + chain verified', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const gw = makeGateway();
  const ctx = buildServer(); ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const created = await jfetch(`${url}/v2/rooms`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'capped', bots: ['forge', 'scribe'], turnLimit: 3, msgCap: 10 }),
    });
    const roomId = created.body.room.id;
    const post = (from, tok, body) => jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: { ...bearer(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ from, body }),
    });
    // default docs example: turnLimit=3 → the 4th bot message is refused
    assert.equal((await post('forge', 'tok-forge', 'one')).status, 201);
    assert.equal((await post('scribe', 'tok-scribe', 'two')).status, 201);
    assert.equal((await post('forge', 'tok-forge', 'three')).status, 201);
    const fourth = await post('scribe', 'tok-scribe', 'four');
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.error, 'turn_limit_reached');
    const detail = await jfetch(`${url}/v2/rooms/${roomId}`, { headers: bearer('tok-atlas') });
    assert.equal(detail.body.room.messages.length, 3, 'refused post not persisted');
    const hit = gw.chain.entries.map((e) => e.payload).find((p) => p.type === 'room_limit_hit');
    assert.ok(hit);
    assert.equal(hit.cap, 'turnLimit');
    assert.equal(gw.chain.verify().ok, true);
  } finally { await ctx.close(); }
});

test('mount: handoff chain over HTTP + proposal → approval → v1 approve executes', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const gw = makeGateway();
  const ctx = buildServer(); ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const created = await jfetch(`${url}/v2/rooms`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chain room', bots: ['forge', 'scribe'], turnLimit: 8, msgCap: 20 }),
    });
    const roomId = created.body.room.id;
    const H = (t) => ({ ...bearer(t), 'content-type': 'application/json' });

    const h1 = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-forge'),
      body: JSON.stringify({ kind: 'handoff', target: 'scribe', chain: ['forge'], body: 'drafted, review please' }),
    });
    assert.equal(h1.status, 201);
    assert.deepEqual(h1.body.deliveredTo, ['scribe']);

    const bad = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-scribe'),
      body: JSON.stringify({ kind: 'handoff', target: 'forge', chain: ['atlas', 'scribe'], body: 'x' }),
    });
    assert.equal(bad.status, 400, 'fabricated chain rejected over HTTP');
    assert.equal(bad.body.error, 'chain_not_backed_by_room_history');

    const good = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-scribe'),
      body: JSON.stringify({ kind: 'handoff', target: 'atlas', chain: ['forge', 'scribe'], body: 'reviewed, operator sign-off' }),
    });
    assert.equal(good.status, 201);
    assert.equal(gw.chain.entries.map((e) => e.payload.type).filter((t) => t === 'room_handoff').length, 2);
    // re-handoff back to a bot already in the chain is a loop → refused
    const loop = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-atlas'),
      body: JSON.stringify({ kind: 'handoff', target: 'forge', chain: ['forge', 'scribe', 'atlas'], body: 'x' }),
    });
    assert.equal(loop.status, 400);
    assert.equal(loop.body.error, 'handoff_loop');

    // proposal through the governed loop: scribe has fs.write:* → allow+dispatch
    const allowed = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-scribe'),
      body: JSON.stringify({ kind: 'proposal', body: { tool: 'fs.write:notes.md', args: { content: 'hello' } } }),
    });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.proposal.decision, 'allow');
    assert.equal(allowed.body.proposal.result.ok, true);

    // forge lacks db.write → needs_approval (201, approval parked)
    const parked = await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: H('tok-forge'),
      body: JSON.stringify({ kind: 'proposal', body: { tool: 'db.write:ledger', args: { usd: 10 } } }),
    });
    assert.equal(parked.status, 201);
    assert.equal(parked.body.proposal.decision, 'needs_approval');
    const approvalId = parked.body.proposal.approvalId;
    assert.ok(approvalId);

    const pend = await jfetch(`${url}/v1/approvals`, { headers: bearer('tok-atlas') });
    assert.ok(pend.body.pending.some((p) => p.id === approvalId), 'approval visible in v1 pending list');

    const approved = await jfetch(`${url}/v1/approvals/${approvalId}/approve`, { method: 'POST', headers: bearer('tok-atlas') });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.result.ok, true, 'parked proposal executed after approval');
    assert.equal(gw.chain.verify().ok, true);
  } finally { await ctx.close(); }
});

test('mount: SSE — hub.broadcast("room", …) streams create + message frames', async () => {
  process.env.TG_ROOMS_FILE = tmpfile('rooms.json');
  const gw = makeGateway();
  const ctx = buildServer(); ctx.attach(gw);
  const url = await listen(ctx.server);
  const frames = [];
  let resolveStream;
  const streamDone = new Promise((r) => { resolveStream = r; });
  try {
    const req = http.get(`${url}/v2/events?token=tok-atlas`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        while (buf.includes('\n\n')) {
          const i = buf.indexOf('\n\n');
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.trim()) frames.push(frame);
        }
      });
      res.on('end', resolveStream);
      res.on('error', resolveStream);
    });
    req.on('error', resolveStream);
    await new Promise((r) => setTimeout(r, 100));

    const created = await jfetch(`${url}/v2/rooms`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sse room', humans: ['jonas'] }),
    });
    const roomId = created.body.room.id;
    await jfetch(`${url}/v2/rooms/${roomId}/messages`, {
      method: 'POST', headers: { ...bearer('tok-atlas'), 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello room' }),
    });
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    await streamDone;

    const roomFrames = frames.filter((f) => f.startsWith('event: room')).map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
    const events = roomFrames.map((p) => p.event);
    assert.ok(events.includes('room_created'), `room_created frame expected, got ${JSON.stringify(events)}`);
    assert.ok(events.includes('message'), 'message frame expected');
    const msgFrame = roomFrames.find((p) => p.event === 'message');
    assert.equal(msgFrame.roomId, roomId);
    assert.equal(msgFrame.from, 'atlas');
  } finally {
    try { getHub(gw).close(); } catch { /* ignore */ }
    await ctx.close();
  }
});

test('durable reload across gateway instances (mount-level)', async () => {
  const f = tmpfile('rooms.json');
  process.env.TG_ROOMS_FILE = f;
  const gw1 = makeGateway();
  const created = await getRoomStore(gw1).create({ name: 'restart-me', bots: ['forge'], humans: ['jonas'] });
  await getRoomStore(gw1).deliver(created.id, { from: 'jonas', body: 'before restart' });

  const gw2 = makeGateway();
  const store2 = getRoomStore(gw2);
  const loaded = store2.get(created.id);
  assert.ok(loaded, 'room must be visible to a fresh gateway on the same file');
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].body, 'before restart');
  // caps carry across the restart
  const out = await store2.deliver(created.id, { from: 'not-a-member', body: 'x' });
  assert.equal(out.error, 'not_member');
});
