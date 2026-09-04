'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// W5 — Live Computer: hash-chained capped frames (summaries only, never raw
// args), state machine, human control (takeover/release → audited
// control_taken/control_released; refusals on the record), SSE stream with
// follow-along replay + live via EventHub broadcast('computer', ...), and
// durable persistence (atomic, 0600, fail closed). Smoke-tested over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { ComputerStore, frameHash, GENESIS_HASH } = require('../src/gateway/computer');

// ── helpers (mirrors artifacts.test.js) ──────────────────────────
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-cmp-'));
  return path.join(dir, name);
}

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
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*'] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      sentry: { name: 'sentry', token: 'tok-sentry', role: 'operator', capabilities: ['approval.decide'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function httpCall(base, method, p, { token = 'tok-forge', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sseCollect(base, p, ms) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const u = new URL(base + p);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.+)$/m.exec(frame);
          if (ev && data) frames.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      });
      res.on('error', () => {});
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, frames }); }, ms);
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auditTypes = (gw) => gw.chain.entries.map((e) => e.payload && e.payload.type);
const auditOf = (gw, type) => gw.chain.entries.filter((e) => e.payload.type === type).map((e) => e.payload);

// ── unit: chain integrity + cap ──────────────────────────────────
test('computer: frames hash-chain and verify', () => {
  const st = new ComputerStore();
  const { session } = st.create({ bot: 'forge', label: 'build run' });
  st.appendFrame(session.id, { kind: 'action', summary: 'opened editor' });
  st.appendFrame(session.id, { kind: 'output', summary: 'tests: 137 passed' });
  const f3 = st.appendFrame(session.id, { kind: 'refusal', summary: 'declined to deploy without approval' });
  assert.equal(f3.ok, true);
  const v = st.verifyChain(session);
  assert.equal(v.ok, true);
  assert.equal(v.length, 3);
  assert.equal(session.frames[0].prevHash, GENESIS_HASH);
  assert.equal(session.frames[1].prevHash, session.frames[0].entryHash);
  // Recompute hashes independently — the chain seals are real.
  for (const f of session.frames) {
    assert.equal(f.entryHash, frameHash(session.id, f.index, f.prevHash, f.ts, f.kind, f.summary, f.ref));
  }
});

test('computer: tampering with a retained frame breaks verification', () => {
  const st = new ComputerStore();
  const { session } = st.create({ bot: 'forge' });
  st.appendFrame(session.id, { kind: 'action', summary: 'ok' });
  st.appendFrame(session.id, { kind: 'action', summary: 'fine' });
  session.frames[0].summary = 'MUTATED';
  const v = st.verifyChain(session);
  assert.equal(v.ok, false);
  assert.equal(v.at, 0);
  assert.equal(v.reason, 'hash_mismatch');
});

test('computer: frames are capped; anchor keeps the window verifiable', () => {
  const st = new ComputerStore({ maxFrames: 5 });
  const { session } = st.create({ bot: 'forge' });
  for (let i = 0; i < 8; i++) {
    st.appendFrame(session.id, { kind: 'output', summary: `line ${i}` });
  }
  assert.equal(session.frames.length, 5, 'retained window capped');
  assert.equal(session.frameCount, 8, 'monotonic count kept');
  assert.deepEqual(session.frames.map((f) => f.index), [3, 4, 5, 6, 7]);
  assert.ok(session.anchor && /^[0-9a-f]{64}$/.test(session.anchor), 'anchor = last dropped hash');
  assert.equal(session.frames[0].prevHash, session.anchor);
  const v = st.verifyChain(session);
  assert.equal(v.ok, true, 'trimmed chain still verifies');
});

test('computer: raw args are refused, summaries only', () => {
  const st = new ComputerStore();
  const { session } = st.create({ bot: 'forge' });
  for (const k of ['args', 'argv', 'secret']) {
    const r = st.appendFrame(session.id, { kind: 'action', summary: 'typing', [k]: { password: 'hunter2' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'raw_args_forbidden');
  }
  const badKind = st.appendFrame(session.id, { kind: 'keystroke', summary: 'x' });
  assert.equal(badKind.error, 'bad_kind');
  assert.equal(session.frames.length, 0);
});

test('computer: states, takeover/release, done is terminal', () => {
  const st = new ComputerStore();
  const { session } = st.create({ bot: 'forge' });
  assert.equal(session.state, 'idle');
  st.setState(session.id, 'running');
  const hold = st.takeover(session.id, 'atlas');
  assert.equal(hold.ok, true);
  assert.equal(hold.session.state, 'awaiting-human');
  assert.equal(hold.session.control.heldBy, 'atlas');
  assert.equal(st.takeover(session.id, 'sentry').error, 'already_held');
  assert.equal(st.release(session.id, 'sentry').error, 'held_by_other'); // only the holder releases
  const rel = st.release(session.id, 'atlas');
  assert.equal(rel.ok, true);
  assert.equal(rel.session.state, 'running');
  assert.equal(rel.session.control, null);
  assert.equal(st.setState(session.id, 'done').ok, true);
  assert.equal(st.setState(session.id, 'running').error, 'bad_transition'); // terminal
  assert.equal(st.appendFrame(session.id, { kind: 'output', summary: 'late' }).error, 'session_done');
});

test('computer: persists atomically at 0600; reload verifies chain; corrupt fails closed', () => {
  const file = tmpFile('computer.json');
  const st = new ComputerStore({ file });
  const { session } = st.create({ bot: 'forge', label: 'screen share' });
  st.appendFrame(session.id, { kind: 'action', summary: 'clicked run' });
  st.appendFrame(session.id, { kind: 'secret-request', summary: 'password prompt appeared — refused' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(file + '.tmp'));

  const st2 = new ComputerStore({ file });
  const s2 = st2.get(session.id);
  assert.equal(s2.frames.length, 2);
  assert.equal(st2.verifyChain(s2).ok, true);

  // Tampered on-disk entry must refuse to load (fail closed).
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].frames[0].summary = 'LIED TO';
  fs.writeFileSync(file, JSON.stringify(rows));
  assert.throws(() => new ComputerStore({ file }), /chain invalid .* refusing to load/);
});

// ── HTTP smoke ───────────────────────────────────────────────────
test('HTTP: session + frames lifecycle is audited and chain-verifies', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-http.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/computer', { body: { label: 'demo run' } });
    assert.equal(made.status, 201);
    const id = made.body.session.id;
    assert.match(id, /^cs_000001$/);
    assert.equal(made.body.session.bot, 'forge');

    await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'set', state: 'running' } });
    const f1 = await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'action', summary: 'typed ls' } });
    assert.equal(f1.status, 201);
    const f2 = await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'output', summary: 'README.md' } });
    assert.equal(f2.status, 201);
    assert.equal(f2.body.frame.prevHash, f1.body.frame.entryHash);
    assert.equal(f2.body.chain.ok, true);

    // Refusal frame kind is first-class and on the record.
    const f3 = await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'refusal', summary: 'bot declined rm -rf' } });
    assert.equal(f3.status, 201);

    const detail = await httpCall(base, 'GET', `/v2/computer/${id}`, { token: 'tok-atlas' });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.frames.length, 3);
    assert.equal(detail.body.chain.ok, true);

    const types = auditTypes(gw);
    assert.ok(types.includes('computer_session_created'));
    assert.equal(auditOf(gw, 'computer_frame').length, 3);
    // Every frame hash is sealed into the audit chain too:
    const sealed = auditOf(gw, 'computer_frame');
    assert.equal(sealed[2].entryHash, f3.body.frame.entryHash);
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    await ctx.close();
  }
});

test('HTTP: raw args on a frame → 422, audited refusal, secret never persisted', async () => {
  const file = tmpFile('computer-args.json');
  process.env.TG_COMPUTER_FILE = file;
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/computer', { body: {} });
    const id = made.body.session.id;
    const att = await httpCall(base, 'POST', `/v2/computer/${id}/frames`, {
      body: { kind: 'action', summary: 'login', args: { password: 'hunter2' } },
    });
    assert.equal(att.status, 422);
    assert.equal(att.body.error, 'raw_args_forbidden');
    const denied = auditOf(gw, 'computer_frame_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].reason, 'raw_args_forbidden');
    assert.ok(gw.chain.verify().ok);
    // The attempted secret value must not appear ANYWHERE on disk.
    const onDisk = fs.readFileSync(file, 'utf8') + gw.chain.entries.map((e) => JSON.stringify(e)).join('');
    assert.ok(!onDisk.includes('hunter2'), 'raw args must never reach disk');
  } finally {
    await ctx.close();
  }
});

test('HTTP: control takeover → control_taken; release → control_released; refusals audited', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-ctl.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/computer', { body: { label: 'screen' } });
    const id = made.body.session.id;

    // Worker cannot take control — refused AND on the record.
    const denied = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { body: { action: 'takeover' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'operator_required');
    assert.equal(auditOf(gw, 'computer_control_denied').length, 1);

    // Operator takes over → session parks in awaiting-human.
    const take = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'takeover' } });
    assert.equal(take.status, 200);
    assert.equal(take.body.session.state, 'awaiting-human');
    let ev = auditOf(gw, 'control_taken');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].by, 'atlas');

    // Double takeover refused (audited). Second operator cannot steal the release.
    const again = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'takeover' } });
    assert.equal(again.status, 409);
    const steal = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-sentry', body: { action: 'release' } });
    assert.equal(steal.status, 409);
    assert.equal(steal.body.error, 'held_by_other');
    assert.equal(auditOf(gw, 'computer_control_denied').length, 3);

    const rel = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'release' } });
    assert.equal(rel.status, 200);
    assert.equal(rel.body.session.state, 'running');
    assert.equal(auditOf(gw, 'control_released').length, 1);
    assert.equal(auditOf(gw, 'control_released')[0].to, 'running');

    // Release with nothing held → refusal recorded, not silence.
    const rel2 = await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'release' } });
    assert.equal(rel2.status, 409);
    assert.ok(auditTypes(gw).includes('computer_control_denied'));
    assert.ok(gw.chain.verify().ok);
  } finally {
    await ctx.close();
  }
});

test('HTTP: foreign worker cannot write frames into someone else\'s session', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-own.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/computer', { body: {} }); // forge owns it
    gw.bots.wren = { name: 'wren', token: 'tok-wren', role: 'worker', capabilities: [] };
    const att = await httpCall(base, 'POST', `/v2/computer/${made.body.session.id}/frames`, {
      token: 'tok-wren', body: { kind: 'action', summary: 'hijack' },
    });
    assert.equal(att.status, 403);
    assert.equal(auditOf(gw, 'computer_frame_denied')[0].reason, 'not_owner');
  } finally {
    await ctx.close();
  }
});

// ── SSE: follow-along replay + live, hub broadcast ───────────────
test('SSE: /v2/computer/:id/stream replays frames then streams live (client-side chain check)', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-sse.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/computer', { body: { label: 'live tab' } });
    const id = made.body.session.id;
    await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'set', state: 'running' } });
    await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'action', summary: 'opened file' } });
    await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'output', summary: 'rendered' } });

    const stream = sseCollect(base, `/v2/computer/${id}/stream?token=tok-atlas`, 600);
    await sleep(150);
    const live = await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'secret-request', summary: 'wants password → parked for human' } });
    await sleep(150);
    await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'takeover' } });
    const { status, frames } = await stream;
    assert.equal(status, 200);

    const hello = frames.find((f) => f.event === 'hello');
    assert.ok(hello && hello.data.session.id === id);
    assert.equal(hello.data.chain.ok, true);

    const cmp = frames.filter((f) => f.event === 'computer');
    const frameEvents = cmp.filter((f) => f.data.action === 'frame');
    // Client-side follow-along: replay(2) + live(1), hashes link end to end.
    assert.equal(frameEvents.length, 3);
    assert.equal(frameEvents[0].data.frame.index, 0);
    assert.equal(frameEvents[2].data.frame.entryHash, live.body.frame.entryHash);
    let prev = GENESIS_HASH;
    for (const fe of frameEvents) {
      assert.equal(fe.data.frame.prevHash, prev, 'client sees an unbroken chain');
      prev = fe.data.frame.entryHash;
    }
    // State changes ride the same stream.
    const states = cmp.filter((f) => f.data.action === 'state');
    assert.ok(states.some((s) => s.data.to === 'awaiting-human'), 'takeover visible on stream');
  } finally {
    await ctx.close();
  }
});

test('SSE: hub /v2/events receives event:computer broadcasts for frames and control', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-hub.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const stream = sseCollect(base, '/v2/events?token=tok-atlas', 700);
    await sleep(100);
    const made = await httpCall(base, 'POST', '/v2/computer', { body: {} });
    const id = made.body.session.id;
    await httpCall(base, 'POST', `/v2/computer/${id}/frames`, { body: { kind: 'action', summary: 'typed' } });
    await httpCall(base, 'POST', `/v2/computer/${id}/control`, { token: 'tok-atlas', body: { action: 'takeover' } });
    const { frames } = await stream;
    const cmp = frames.filter((f) => f.event === 'computer');
    assert.ok(cmp.length >= 3, `expected ≥3 computer frames, got ${cmp.length}`);
    assert.ok(cmp.some((f) => f.data.action === 'session'));
    assert.ok(cmp.some((f) => f.data.action === 'frame'));
    assert.ok(cmp.some((f) => f.data.action === 'control' && f.data.control === 'taken'));
    // Global firehose carries summaries, never raw args — frames on the hub
    // are the same frame objects (already args-free by store validation).
  } finally {
    await ctx.close();
  }
});

test('HTTP: unauthenticated computer stream → 401; unknown session → 404', async () => {
  process.env.TG_COMPUTER_FILE = tmpFile('computer-auth.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const res = await fetch(base + '/v2/computer');
    assert.equal(res.status, 401);
    assert.ok(auditTypes(gw).includes('auth_rejected'));
    const missing = await httpCall(base, 'GET', '/v2/computer/cs_999999');
    assert.equal(missing.status, 404);
  } finally {
    await ctx.close();
  }
});
