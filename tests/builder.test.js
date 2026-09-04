'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// W3 tests — custom-agent builder + profiles.
// Covers: validation (no invented caps), RBAC (operator_required → 403 +
// audit approval_forbidden), durability (agents.json round-trip, corrupt-file
// fail closed), mount smoke tests over real HTTP, chain verify.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Gateway, send } = require('../src/gateway/server');
const { AgentStore, getStore, validateAgent, isPrivilegedCap } = require('../src/gateway/agent-store');

// Isolation: never touch the repo's real data/ dir. Each test process gets a
// fresh temp dir; the durability test overrides TG_DATA_DIR per-case and
// restores it in finally.
process.env.TG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-builder-'));

const BOTS = {
  forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.write:*', 'fs.read'] },
  scout: { name: 'scout', token: 'tok-scout', role: 'analyst', capabilities: ['fs.read', 'web.get'] },
  atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
};

function makeGateway(opts = {}) {
  return new Gateway({
    bots: BOTS,
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
    ...opts,
  });
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

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agents-'));
  return path.join(dir, 'agents.json');
}

// ── validation ───────────────────────────────────────────────────────

test('validateAgent: accepts a valid worker agent and defaults caps from role', () => {
  const v = validateAgent({ name: 'helper', role: 'worker' }, { existing: null });
  assert.equal(v.ok, true);
  assert.deepEqual(v.agent.capabilities, ['fs.read', 'fs.write:*', 'web.get', 'web.search']);
  assert.equal(v.agent.persona, null);
  // createdAt is filled by the store at create-time (not by the validator).
});

test('validateAgent: rejects invented capabilities not in ROLE_CAPABILITIES[role]', () => {
  assert.equal(validateAgent({ name: 'x1', role: 'analyst', capabilities: ['fs.write:*'] }).error, 'invalid_capability');
  assert.equal(validateAgent({ name: 'x2', role: 'worker', capabilities: ['db.read:*'] }).error, 'invalid_capability');
  assert.equal(validateAgent({ name: 'x3', role: 'auditor', capabilities: ['web.get'] }).error, 'invalid_capability');
});

test('validateAgent: rejects meta-caps and wildcard', () => {
  assert.equal(validateAgent({ name: 'x4', role: 'operator', capabilities: ['*'] }).error, 'invalid_capability');
  assert.equal(validateAgent({ name: 'x5', role: 'operator', capabilities: ['approval.decide'] }).error, 'invalid_capability');
});

test('validateAgent: role/capability must match — role defines the cap set', () => {
  // operator role legitimately grants shell.run, analyst never does.
  assert.equal(validateAgent({ name: 'x6', role: 'operator', capabilities: ['shell.run'] }).ok, true);
  assert.equal(validateAgent({ name: 'x7', role: 'analyst', capabilities: ['shell.run'] }).error, 'invalid_capability');
});

test('validateAgent: rejects unknown role, bad names, oversized persona, non-array caps', () => {
  assert.equal(validateAgent({ name: 'roleless', role: 'superadmin' }).error, 'invalid_role');
  assert.equal(validateAgent({ name: 'Bad Name', role: 'worker' }).error, 'invalid_name');
  assert.equal(validateAgent({ name: 'x', role: 'worker' }).error, 'invalid_name', 'single-char name too short');
  assert.equal(validateAgent({ name: 'a'.repeat(40), role: 'worker' }).error, 'invalid_name');
  assert.equal(validateAgent({ name: 'ok-name', role: 'worker', persona: 'x'.repeat(2001) }).error, 'invalid_persona');
  assert.equal(validateAgent({ name: 'ok-name', role: 'worker', capabilities: 'fs.read' }).error, 'invalid_capabilities');
});

test('validateAgent: name reserved by configured bots', () => {
  const v = validateAgent({ name: 'forge', role: 'worker' }, { reservedNames: () => ['forge'] });
  assert.equal(v.error, 'name_reserved');
});

test('isPrivilegedCap: destructive/secret classes are privileged', () => {
  assert.equal(isPrivilegedCap('shell.run'), true);
  assert.equal(isPrivilegedCap('fs.delete:*'), true);
  assert.equal(isPrivilegedCap('secret.read:*'), true);
  assert.equal(isPrivilegedCap('fs.read'), false);
  assert.equal(isPrivilegedCap('web.get'), false);
});

// ── store CRUD + RBAC (in-process) ──────────────────────────────────

test('AgentStore: create → get → list → update → remove lifecycle', () => {
  const store = new AgentStore({ now: () => 1000 });
  const caller = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  const c = store.create({ name: 'helper', role: 'worker', persona: 'helpful' }, caller);
  assert.equal(c.ok, true);
  assert.equal(c.agent.createdAt, 1000);

  assert.equal(store.get('helper').persona, 'helpful');
  assert.equal(store.get('nope'), null);
  assert.equal(store.list().length, 1);

  const u = store.update('helper', { persona: 'very helpful' }, caller);
  assert.equal(u.ok, true);
  assert.equal(u.agent.persona, 'very helpful');
  assert.equal(u.agent.createdAt, 1000, 'createdAt immutable through update');

  const r = store.remove('helper', caller);
  assert.equal(r.ok, true);
  assert.equal(store.get('helper'), null);
});

test('AgentStore: create rejects duplicates and reserved bot names', () => {
  const store = new AgentStore({ now: () => 1000, reservedNames: () => ['forge'] });
  const caller = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  assert.equal(store.create({ name: 'helper', role: 'worker' }, caller).ok, true);
  assert.equal(store.create({ name: 'helper', role: 'worker' }, caller).error, 'exists');
  assert.equal(store.create({ name: 'forge', role: 'worker' }, caller).error, 'name_reserved');
});

test('RBAC: non-operator cannot create privileged agent (operator_required)', () => {
  const store = new AgentStore({ now: () => 1000 });
  const worker = { name: 'forge', role: 'worker', capabilities: ['fs.write:*'] };
  const r = store.create({ name: 'demolisher', role: 'operator', capabilities: ['shell.run'] }, worker);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'operator_required');
  assert.equal(r.privileged, true);
  assert.equal(store.get('demolisher'), null, 'agent must not be persisted on RBAC failure');
});

test('RBAC: non-operator cannot update agent to privileged caps', () => {
  const store = new AgentStore({ now: () => 1000 });
  const worker = { name: 'forge', role: 'worker', capabilities: ['fs.write:*'] };
  const operator = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  store.create({ name: 'helper', role: 'worker' }, operator);
  const r = store.update('helper', { role: 'operator', capabilities: ['shell.run'] }, worker);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'operator_required');
  assert.deepEqual(store.get('helper').capabilities, ['fs.read', 'fs.write:*', 'web.get', 'web.search']);
});

test('RBAC: operator may create and update privileged agents', () => {
  const store = new AgentStore({ now: () => 1000 });
  const operator = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  const c = store.create({ name: 'demolisher', role: 'operator', capabilities: ['shell.run'] }, operator);
  assert.equal(c.ok, true);
  const u = store.update('demolisher', { capabilities: [] }, operator);
  assert.equal(u.ok, true);
});

test('RBAC: delete is operator-only; profiles readable/writable by owner or operator', () => {
  const store = new AgentStore({ now: () => 1000 });
  const worker = { name: 'forge', role: 'worker', capabilities: ['fs.write:*'] };
  const operator = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  store.create({ name: 'helper', role: 'worker' }, operator);

  assert.equal(store.remove('helper', worker).error, 'operator_required');
  assert.equal(store.remove('helper', operator).ok, true);

  assert.equal(store.setProfile('forge', { persona: 'me' }, worker).ok, true);
  assert.equal(store.setProfile('forge', { persona: 'hacked' }, { name: 'scout', role: 'analyst', capabilities: [] }).error, 'operator_required');
  assert.equal(store.getProfile('forge', worker).ok, true);
  assert.equal(store.getProfile('scout', worker).error, 'operator_required');
  assert.equal(store.getProfile('forge', operator).ok, true);
});

// ── durability ───────────────────────────────────────────────────────

test('durability: agents.json survives store restart (atomic tmp+rename, 0600)', () => {
  const file = tmpFile();
  const caller = { name: 'atlas', role: 'operator', capabilities: ['*'] };
  let store = new AgentStore({ file, now: () => 4242 });
  store.create({ name: 'helper', role: 'worker', persona: 'p1' }, caller);
  store.create({ name: 'num-cruncher', role: 'analyst', capabilities: ['db.read:*'] }, caller);
  store.setProfile('helper', { persona: 'prof', settings: { theme: 'dark' } }, caller);

  // file exists, is 0600, no leftover tmp
  const st = fs.statSync(file);
  // DrvFs skip
  if (!(process.platform === 'linux' && process.cwd().startsWith('/mnt/')))
    assert.equal(st.mode & 0o777, 0o600);
  assert.ok(fs.existsSync(file), 'file must exist');
  assert.ok(!fs.existsSync(file + '.tmp'), 'tmp file must be renamed away');

  const store2 = new AgentStore({ file, now: () => 9999 });
  assert.equal(store2.get('helper').persona, 'p1');
  assert.equal(store2.get('num-cruncher').role, 'analyst');
  assert.deepEqual(store2.getProfile('helper', caller).profile.settings, { theme: 'dark' });
  // createdAt survives restart
  assert.equal(store2.get('helper').createdAt, 4242);
});

test('durability: corrupt agents.json refuses to load (fail closed)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"agents": [ { "name": "helper" '); // truncated JSON
  assert.throws(() => new AgentStore({ file }), /refusing to load/);
});

test('durability: structurally invalid stored agent refuses to load (fail closed)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agents: [{ name: 'evil', role: 'worker', capabilities: ['shell.run'], createdAt: 1 }],
    profiles: {},
  }));
  assert.throws(() => new AgentStore({ file }), /refusing to load/);
});

// ── HTTP mounts over real server ─────────────────────────────────────

test('mount: POST /v2/agents creates a custom agent (201) + audited', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'reporter', role: 'analyst', persona: 'writes reports' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.agent.name, 'reporter');
    assert.equal(body.agent.role, 'analyst');
    assert.deepEqual(body.agent.capabilities, ['fs.read', 'web.get', 'web.search', 'db.read:*']);
    assert.equal(body.agent.token, undefined, 'no tokens ever');
    assert.ok(gw.chain.verify().ok, 'chain must verify');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'agent_created'));
  } finally {
    await ctx.close();
  }
});

test('mount: POST /v2/agents validation errors → 400, audited', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    for (const body of [
      { name: 'Bad Name', role: 'worker' },
      { name: 'okname', role: 'wizard' },
      { name: 'okname2', role: 'worker', capabilities: ['shell.run'] },
    ]) {
      const res = await fetch(`${url}/v2/agents`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-atlas' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    // reserving a configured bot's name → 409 conflict
    const dup = await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'forge', role: 'worker' }),
    });
    assert.equal(dup.status, 409);
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'agent_rejected'));
  } finally {
    await ctx.close();
  }
});

test('mount: RBAC — non-operator creating privileged agent → 403 + audit approval_forbidden', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-forge' },
      body: JSON.stringify({ name: 'demolisher', role: 'operator', capabilities: ['shell.run'] }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'operator_required');
    const forbidden = gw.chain.entries.filter((e) => e.payload.type === 'approval_forbidden');
    assert.ok(forbidden.length >= 1, 'approval_forbidden must be audited');
    assert.equal(forbidden[0].payload.agent, 'demolisher');
    assert.equal(forbidden[0].payload.by, 'forge');
    assert.ok(gw.chain.verify().ok, 'chain must verify');
    // nothing persisted
    const list = await fetch(`${url}/v2/agents`, { headers: { authorization: 'Bearer tok-atlas' } });
    const lb = await list.json();
    assert.equal(lb.agents.find((a) => a.name === 'demolisher'), undefined);
  } finally {
    await ctx.close();
  }
});

test('mount: GET /v2/agents lists, GET /v2/agents/:name fetches, 404 unknown', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'reporter', role: 'analyst' }),
    });
    const list = await fetch(`${url}/v2/agents`, { headers: { authorization: 'Bearer tok-scout' } });
    assert.equal(list.status, 200);
    const lb = await list.json();
    assert.equal(lb.agents.length, 1);
    assert.equal(lb.agents[0].name, 'reporter');
    assert.equal(lb.agents[0].token, undefined);

    const one = await fetch(`${url}/v2/agents/reporter`, { headers: { authorization: 'Bearer tok-scout' } });
    assert.equal(one.status, 200);
    const ob = await one.json();
    assert.equal(ob.agent.role, 'analyst');

    const miss = await fetch(`${url}/v2/agents/ghost`, { headers: { authorization: 'Bearer tok-scout' } });
    assert.equal(miss.status, 404);
  } finally {
    await ctx.close();
  }
});

test('mount: PUT /v2/agents/:name updates persona; non-operator privileged update → 403', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'reporter', role: 'analyst', persona: 'v1' }),
    });
    const res = await fetch(`${url}/v2/agents/reporter`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-scout' },
      body: JSON.stringify({ persona: 'v2' }),
    });
    assert.equal(res.status, 200);
    const one = await (await fetch(`${url}/v2/agents/reporter`, { headers: { authorization: 'Bearer tok-scout' } })).json();
    assert.equal(one.agent.persona, 'v2');

    // analyst tries to grant itself shell.run → 403 + approval_forbidden
    const bad = await fetch(`${url}/v2/agents/reporter`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-scout' },
      body: JSON.stringify({ capabilities: ['shell.run'] }),
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error, 'operator_required');
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'approval_forbidden' && e.payload.action === 'agent_update_privileged'));

    // name is immutable
    const rename = await fetch(`${url}/v2/agents/reporter`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'other' }),
    });
    assert.equal(rename.status, 400);
  } finally {
    await ctx.close();
  }
});

test('mount: DELETE /v2/agents/:name operator-only, removes profile too', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'reporter', role: 'analyst' }),
    });
    const no = await fetch(`${url}/v2/agents/reporter`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok-forge' },
    });
    assert.equal(no.status, 403);
    const yes = await fetch(`${url}/v2/agents/reporter`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok-atlas' },
    });
    assert.equal(yes.status, 200);
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'agent_deleted'));
    const miss = await fetch(`${url}/v2/agents/reporter`, { headers: { authorization: 'Bearer tok-atlas' } });
    assert.equal(miss.status, 404);
  } finally {
    await ctx.close();
  }
});

test('mount: PUT /v2/profiles/:who — owner writes own profile, persisted', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/profiles/forge`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-forge' },
      body: JSON.stringify({ persona: 'builder bot', settings: { timezone: 'UTC' } }),
    });
    assert.equal(res.status, 200);
    const pb = await res.json();
    assert.equal(pb.profile.persona, 'builder bot');
    assert.deepEqual(pb.profile.settings, { timezone: 'UTC' });
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'profile_updated'));

    const get = await fetch(`${url}/v2/profiles/forge`, { headers: { authorization: 'Bearer tok-forge' } });
    assert.equal(get.status, 200);
    const gb = await get.json();
    assert.equal(gb.profile.persona, 'builder bot');
  } finally {
    await ctx.close();
  }
});

test('mount: RBAC — profile access is owner-or-operator (403 + audit)', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    // scout reads forge's profile → 403
    const get = await fetch(`${url}/v2/profiles/forge`, { headers: { authorization: 'Bearer tok-scout' } });
    assert.equal(get.status, 403);
    assert.equal((await get.json()).error, 'operator_required');

    // scout writes forge's profile → 403
    const put = await fetch(`${url}/v2/profiles/forge`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-scout' },
      body: JSON.stringify({ persona: 'hijacked' }),
    });
    assert.equal(put.status, 403);

    // operator may read and write any profile
    const opGet = await fetch(`${url}/v2/profiles/forge`, { headers: { authorization: 'Bearer tok-atlas' } });
    assert.equal(opGet.status, 200);
    const opPut = await fetch(`${url}/v2/profiles/forge`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ persona: 'set by operator' }),
    });
    assert.equal(opPut.status, 200);

    // forge's persona was NOT hijacked by scout
    const forgeView = await (await fetch(`${url}/v2/profiles/forge`, { headers: { authorization: 'Bearer tok-forge' } })).json();
    assert.equal(forgeView.profile.persona, 'set by operator');

    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'approval_forbidden' && e.payload.action === 'profile_read'));
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'approval_forbidden' && e.payload.action === 'profile_write'));
    assert.ok(gw.chain.verify().ok, 'chain must verify');
  } finally {
    await ctx.close();
  }
});

test('mount: profile validation — invalid settings/persona → 400, empty → 400', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    for (const body of [
      { settings: 'not-an-object' },
      { persona: 42 },
      { persona: 'x'.repeat(2001) },
      {},
    ]) {
      const res = await fetch(`${url}/v2/profiles/forge`, {
        method: 'PUT',
        headers: { authorization: 'Bearer tok-forge' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    // oversized settings
    const big = await fetch(`${url}/v2/profiles/forge`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-forge' },
      body: JSON.stringify({ settings: { blob: 'x'.repeat(9000) } }),
    });
    assert.equal(big.status, 400);
  } finally {
    await ctx.close();
  }
});

test('mount: durability through the gateway — agents.json written under TG_DATA_DIR', async () => {
  const file = tmpFile();
  const dir = path.dirname(file);
  const gw = makeGateway();
  // Point the store at our tmp dir before first use.
  process.env.TG_DATA_DIR = dir;
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    await fetch(`${url}/v2/agents`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({ name: 'durable', role: 'worker', persona: 'survives restart' }),
    });
    assert.ok(fs.existsSync(file), 'agents.json must exist under TG_DATA_DIR');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.agents[0].name, 'durable');
    assert.equal(onDisk.agents[0].persona, 'survives restart');

    // A fresh gateway over the same data dir loads the stored agent.
    const gw2 = makeGateway();
    const ctx2 = buildServer();
    ctx2.attach(gw2);
    const url2 = await listen(ctx2.server);
    try {
      const res = await fetch(`${url2}/v2/agents/durable`, { headers: { authorization: 'Bearer tok-atlas' } });
      assert.equal(res.status, 200);
      const ab = await res.json();
      assert.equal(ab.agent.persona, 'survives restart');
    } finally {
      await ctx2.close();
    }
  } finally {
    delete process.env.TG_DATA_DIR;
    await ctx.close();
  }
});

test('mount: unauthenticated requests → 401', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/agents`);
    assert.equal(res.status, 401);
    const res2 = await fetch(`${url}/v2/agents`);
    assert.equal(res2.status, 401);
    const res3 = await fetch(`${url}/v2/profiles/forge`);
    assert.equal(res3.status, 401);
  } finally {
    await ctx.close();
  }
});

test('mount: unknown /v2/agents route shape → 404/405, not swallowed', async () => {
  const gw = makeGateway();
  const ctx = buildServer();
  ctx.attach(gw);
  const url = await listen(ctx.server);
  try {
    // POST with a name segment is not a valid route → 405
    const res = await fetch(`${url}/v2/agents/reporter`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-atlas' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 405);
  } finally {
    await ctx.close();
  }
});

test('getStore: one store per gateway, reservedNames blocks configured bots', async () => {
  const gw = makeGateway();
  const s1 = getStore(gw);
  const s2 = getStore(gw);
  assert.equal(s1, s2);
  assert.deepEqual(s1.reservedNames(), ['forge', 'scout', 'atlas']);
});

test('send helper smoke (parity with other mounts)', () => {
  // trivial: JSON round-trip safety of audit payloads is enforced by the
  // store's own save path; here just assert the helper exists on server.
  assert.equal(typeof send, 'function');
});
