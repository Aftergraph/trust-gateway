'use strict';
// W5 — Artifacts: ArtifactStore (atomic, 0600, fail closed), versioned PUT,
// audit artifact_created/artifact_updated, SSE broadcast('artifact') and the
// follow-along stream GET /v2/artifacts/:id/stream (replay + live), smoke-
// tested over real HTTP through the mount runner.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');
const { ArtifactStore, KINDS } = require('../src/gateway/artifacts');

// ── helpers ──────────────────────────────────────────────────────
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-art-'));
  return path.join(dir, name);
}

function buildServer() {
  const server = http.createServer();
  let gw = null;
  return {
    server,
    attach(gateway) {
      gw = gateway;
      server.on('request', (req, res) => gw.handle(req, res));
    },
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
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function httpCall(base, method, p, { token = 'tok-forge', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
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

// Collect SSE frames for a while. Returns { frames, req } — frames are
// complete `event: X\ndata: {...}` blocks as parsed objects.
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

function auditTypes(gw) {
  return gw.chain.entries.map((e) => e.payload && e.payload.type);
}

// ── unit: ArtifactStore ──────────────────────────────────────────
test('artifacts: create validates kind and shape', () => {
  const st = new ArtifactStore();
  assert.deepEqual([...KINDS], ['code', 'doc', 'image-ref', 'report']);
  const bad = st.create({ kind: 'spell', title: 'x', content: 'y', bot: 'forge' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_kind');
  const noTitle = st.create({ kind: 'code', title: '', content: 'y' });
  assert.equal(noTitle.error, 'bad_title');
  const out = st.create({ kind: 'code', title: 'server.js fix', content: 'process.exit(0)', bot: 'forge', sessionRef: 'cs_000001' });
  assert.equal(out.ok, true);
  const a = out.artifact;
  assert.match(a.id, /^art_000001$/);
  assert.equal(a.version, 1);
  assert.equal(a.versions.length, 1);
  assert.equal(a.sessionRef, 'cs_000001');
  assert.ok(/^[0-9a-f]{64}$/.test(a.versions[0].hash));
});

test('artifacts: versioned PUT appends history, never rewrites', () => {
  const st = new ArtifactStore();
  const { artifact } = st.create({ kind: 'doc', title: 'runbook', content: 'v1 body', bot: 'forge' });
  const r2 = st.putVersion(artifact.id, { bot: 'forge', content: 'v2 body' });
  assert.equal(r2.ok, true);
  assert.equal(r2.artifact.version, 2);
  const r3 = st.putVersion(artifact.id, { bot: 'atlas', title: 'runbook v3' });
  assert.equal(r3.ok, true);
  assert.equal(r3.artifact.title, 'runbook v3');
  assert.equal(r3.artifact.content, 'v2 body'); // content untouched by title-only PUT
  const versions = artifact.versions;
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map((v) => v.v), [1, 2, 3]);
  assert.equal(versions[0].content, 'v1 body'); // v1 body still in history
  assert.notEqual(versions[1].hash, versions[2].hash);
  assert.equal(st.putVersion('art_999999', { content: 'x' }).error, 'not_found');
  assert.equal(st.putVersion(artifact.id, {}).error, 'empty_update');
});

test('artifacts: persists atomically at 0600 and reloads; corrupt fails closed', () => {
  const file = tmpFile('artifacts.json');
  const st = new ArtifactStore({ file });
  const { artifact } = st.create({ kind: 'report', title: 'q3', content: 'numbers', bot: 'forge', sessionRef: 'cs_1' });
  st.putVersion(artifact.id, { bot: 'forge', content: 'numbers, fixed' });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'artifact file must be 0600');
  assert.ok(!fs.existsSync(file + '.tmp'), 'tmp file must be renamed away');

  const st2 = new ArtifactStore({ file });
  const reloaded = st2.get(artifact.id);
  assert.ok(reloaded);
  assert.equal(reloaded.version, 2);
  assert.equal(reloaded.content, 'numbers, fixed');

  fs.writeFileSync(file + '.corrupt', '{not json');
  fs.renameSync(file + '.corrupt', file);
  assert.throws(() => new ArtifactStore({ file }), /refusing to load \(fail closed\)/);
});

// ── HTTP smoke: mount + auth + audit ─────────────────────────────
test('HTTP: POST /v2/artifacts creates, audits artifact_created, chain verifies', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-http.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const res = await httpCall(base, 'POST', '/v2/artifacts', {
      body: { kind: 'code', title: 'patch.ts', content: 'export const x = 1;', sessionRef: 'cs_000042' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.artifact.kind, 'code');
    assert.equal(res.body.artifact.bot, 'forge');

    const got = await httpCall(base, 'GET', '/v2/artifacts/' + res.body.artifact.id);
    assert.equal(got.status, 200);
    assert.equal(got.body.artifact.content, 'export const x = 1;');

    const list = await httpCall(base, 'GET', '/v2/artifacts');
    assert.equal(list.status, 200);
    assert.equal(list.body.artifacts.length, 1);
    assert.equal(list.body.artifacts[0].content, undefined, 'list projection carries no bodies');

    assert.ok(auditTypes(gw).includes('artifact_created'));
    const created = gw.chain.entries.find((e) => e.payload.type === 'artifact_created');
    assert.equal(created.payload.bot, 'forge');
    assert.equal(created.payload.sessionRef, 'cs_000042');
    assert.equal(gw.chain.verify().ok, true, 'audit chain must verify after artifact writes');
  } finally {
    await ctx.close();
  }
});

test('HTTP: unauthenticated artifact calls → 401 and are audited', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-auth.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const u = new URL(base + '/v2/artifacts');
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: '/v2/artifacts', method: 'GET' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(res.status, 401);
    assert.ok(auditTypes(gw).includes('auth_rejected'));
  } finally {
    await ctx.close();
  }
});

test('HTTP: PUT adds a version (audit artifact_updated); foreign worker is refused', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-put.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/artifacts', { body: { kind: 'doc', title: 'notes', content: 'a' } });
    const id = made.body.artifact.id;

    const upd = await httpCall(base, 'PUT', `/v2/artifacts/${id}`, { body: { content: 'b' } });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.version.v, 2);

    // forge is a plain worker; atlas (operator) may version anyone's artifact.
    const byOp = await httpCall(base, 'PUT', `/v2/artifacts/${id}`, { token: 'tok-atlas', body: { title: 'notes*' } });
    assert.equal(byOp.status, 200);
    assert.equal(byOp.body.version.v, 3);

    const kinds = auditTypes(gw);
    assert.equal(kinds.filter((t) => t === 'artifact_updated').length, 2);
    assert.equal(gw.chain.verify().ok, true);

    // A different worker must not rewrite forge's artifact.
    gw.bots.wren = { name: 'wren', token: 'tok-wren', role: 'worker', capabilities: [] };
    const denied = await httpCall(base, 'PUT', `/v2/artifacts/${id}`, { token: 'tok-wren', body: { content: 'hijack' } });
    assert.equal(denied.status, 403);
    assert.ok(auditTypes(gw).includes('artifact_update_denied'));
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    await ctx.close();
  }
});

// ── SSE: hub broadcast + follow-along stream (replay + live) ─────
test('SSE: hub /v2/events receives event:artifact broadcasts on create and update', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-hub.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const stream = sseCollect(base, '/v2/events?token=tok-atlas', 700);
    await sleep(100);
    const made = await httpCall(base, 'POST', '/v2/artifacts', { body: { kind: 'report', title: 'r', content: 'x' } });
    await httpCall(base, 'PUT', `/v2/artifacts/${made.body.artifact.id}`, { body: { content: 'y' } });
    const { frames } = await stream;
    const art = frames.filter((f) => f.event === 'artifact');
    assert.ok(art.length >= 2, `expected ≥2 artifact frames, got ${art.length}`);
    assert.equal(art[0].data.action, 'created');
    assert.equal(art[1].data.action, 'updated');
    assert.equal(art[1].data.version.v, 2);
    assert.equal(art[1].data.version.content, undefined, 'global firehose never carries content bodies');
  } finally {
    await ctx.close();
  }
});

test('SSE: follow-along stream replays every version then goes live', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-follow.json');
  const ctx = buildServer();
  const gw = makeGateway();
  ctx.attach(gw);
  const base = await listen(ctx.server);
  try {
    const made = await httpCall(base, 'POST', '/v2/artifacts', { body: { kind: 'code', title: 'algo', content: 'v1' } });
    const id = made.body.artifact.id;
    await httpCall(base, 'PUT', `/v2/artifacts/${id}`, { body: { content: 'v2' } });

    const stream = sseCollect(base, `/v2/artifacts/${id}/stream?token=tok-forge`, 600);
    await sleep(150);
    await httpCall(base, 'PUT', `/v2/artifacts/${id}`, { body: { content: 'v3 live' } });
    const { status, frames } = await stream;
    assert.equal(status, 200);

    const hello = frames.find((f) => f.event === 'hello');
    assert.ok(hello, 'hello frame with artifact projection');
    assert.equal(hello.data.artifact.version, 2);

    const art = frames.filter((f) => f.event === 'artifact');
    const replays = art.filter((f) => f.data.action === 'replay');
    assert.deepEqual(replays.map((f) => f.data.version.v), [1, 2], 'replay covers history oldest-first');
    assert.equal(replays[0].data.version.content, 'v1');
    const live = art.filter((f) => f.data.action === 'updated');
    assert.equal(live.length, 1);
    assert.equal(live[0].data.version.v, 3);
    assert.equal(live[0].data.version.content, 'v3 live');
    assert.equal(live[0].data.artifactId, id);
  } finally {
    await ctx.close();
  }
});

test('SSE: artifact stream for unknown id → 404', async () => {
  process.env.TG_ARTIFACTS_FILE = tmpFile('artifacts-404.json');
  const ctx = buildServer();
  ctx.attach(makeGateway());
  const base = await listen(ctx.server);
  try {
    const u = new URL(base + '/v2/artifacts/art_999999/stream?token=tok-forge');
    const res = await new Promise((resolve, reject) => {
      http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (r) => {
        r.resume(); r.on('end', () => resolve(r.statusCode));
      }).on('error', reject);
    });
    assert.equal(res, 404);
  } finally {
    await ctx.close();
  }
});
