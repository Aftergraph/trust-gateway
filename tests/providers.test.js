'use strict';
// W6 tests — provider/model registry + mounts.
// Mock network with a local http stub; NEVER hit real providers.
// Key rule: no sk- pattern (and no token-like strings) in ANY response.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Gateway } = require('../src/gateway/server');
const { ProviderRegistry, SEED, FREE_LANES } = require('../src/gateway/providers');

const EXPECTED_SET = [
  'dialagram', 'ollama-cloud', 'openrouter', 'opencode-zen',
  'opencode-go', 'anthropic', 'openai',
];

// Any plausible key material — asserted absent in every response body.
const KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}|fw-[a-z0-9]{4,}|at-tok|Bearer\s+[A-Za-z0-9]{16,}/i;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w6-providers-'));
}

function makeGateway() {
  return new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: [] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
  });
}

function buildServer(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  return {
    server,
    url: new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      server.on('error', reject);
    }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function get(url, p, token = 'tok-atlas') {
  const res = await fetch(`${url}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

async function post(url, p, body, token = 'tok-atlas') {
  const res = await fetch(`${url}${p}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

// ── registry unit ────────────────────────────────────────────────────

test('registry seeds the real provider set with kinds + model lists', () => {
  const reg = new ProviderRegistry();
  const names = reg.list().map((p) => p.name).sort();
  assert.deepEqual(names, [...EXPECTED_SET].sort());
  const dial = reg.get('dialagram');
  assert.equal(dial.kind, 'proxy');
  assert.equal(dial.defaultModel, 'qwen-3.7-max');
  assert.ok(dial.models.length >= 17, 'dialagram list mirrors config.yaml (17 models)');
  assert.ok(dial.models.includes('qwen-3.7-max') && dial.models.includes('deepseek-v4'));
  assert.equal(reg.get('ollama-cloud').kind, 'aggregator');
  assert.equal(reg.get('openai').kind, 'direct');
  assert.ok(reg.get('ollama-cloud').models.includes('glm-5.3-flash'));
  assert.ok(reg.get('openrouter').models.includes('minimax/minimax-m3:free'));
  assert.ok(reg.get('opencode-zen').models.includes('laguna-s-2.1-free'));
});

test('dialagram model list matches config.yaml exactly', () => {
  // config.yaml providers.dialagram.models (source of truth for the seed)
  const CONFIG_LIST = [
    'deepseek-v4', 'meta-muse-spark-1.2', 'nexum-router', 'qwen-3.5-omni-plus',
    'qwen-3.5-plus', 'qwen-3.5-plus-thinking', 'qwen-3.6-max-preview',
    'qwen-3.6-max-preview-thinking', 'qwen-3.6-plus', 'qwen-3.6-plus-thinking',
    'qwen-3.7-max', 'qwen-3.7-max-thinking', 'qwen-3.7-plus',
    'qwen-3.7-plus-thinking', 'qwen-3.8-max-thinking', 'tencent-hy3',
    'xiaomi-mimo-2.5',
  ];
  assert.deepEqual(new ProviderRegistry().get('dialagram').models, CONFIG_LIST);
});

test('persistence: round-trips to file, survives reload, merges new seed models', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'providers.json');
    const a = new ProviderRegistry({ file });
    a.get('ollama-cloud').status = 'ok';
    a.plan({ task: 'write code', preferFree: true });
    a._save();
    const b = new ProviderRegistry({ file });
    assert.equal(b.get('ollama-cloud').status, 'ok');
    assert.deepEqual(b.get('dialagram').models, a.get('dialagram').models);
    // corrupt file → fail closed
    fs.writeFileSync(file, '{not json');
    assert.throws(() => new ProviderRegistry({ file }), /refusing to load/);
    fs.writeFileSync(file, '[]');
    assert.throws(() => new ProviderRegistry({ file }), /refusing to load/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan heuristic ───────────────────────────────────────────────────

test('plan with preferFree: free lanes strictly first (ollama → OR free → OCZ free)', () => {
  const reg = new ProviderRegistry();
  const plan = reg.plan({ task: 'refactor the dispatcher module', preferFree: true, maxLanes: 6 });
  assert.equal(plan.taskTag, 'code');
  assert.deepEqual(plan.primary, { provider: 'ollama-cloud', model: 'glm-5.3-flash' });
  const flat = [plan.primary, ...plan.fallbacks];
  assert.deepEqual(flat.slice(0, 3), [
    { provider: 'ollama-cloud', model: 'glm-5.3-flash' },
    { provider: 'openrouter', model: 'minimax/minimax-m3:free' },
    { provider: 'opencode-zen', model: 'laguna-s-2.1-free' },
  ]);
  // free lanes before any paid lane
  const firstPaidIdx = flat.findIndex((l) => !FREE_LANES.some((f) => f.provider === l.provider && f.model === l.model) && !/:free$/.test(l.model));
  const lastFreeIdx = flat.reduce((acc, l, i) => (l.free ? i : acc), -1);
  assert.ok(lastFreeIdx < firstPaidIdx, 'all free lanes rank before paid lanes');
});

test('plan without preferFree: paid lanes demote only slightly; free lanes still rank first', () => {
  const reg = new ProviderRegistry();
  const plan = reg.plan({ task: 'analyze this quarterly dataset', preferFree: false, maxLanes: 8 });
  assert.equal(plan.taskTag, 'reasoning');
  // free-lane nudge (-0.5) keeps the free lanes on top; the primary is a
  // free lane while dialagram stays the top paid fallback.
  assert.equal(plan.primary.provider, 'ollama-cloud');
  assert.ok(plan.lanes.some((l) => l.provider === 'dialagram'), 'dialagram appears among lanes');
  assert.ok(plan.fallbacks.some((l) => l.provider === 'dialagram'), 'dialagram is a fallback when paid lanes are allowed (not excluded)');
});

test('plan output validates against the registry (every lane exists)', () => {
  const reg = new ProviderRegistry();
  for (const preferFree of [true, false]) {
    const plan = reg.plan({ task: 'do a thing', preferFree, maxLanes: 12 });
    const catalog = reg.models();
    for (const lane of [plan.primary, ...plan.fallbacks]) {
      const hit = catalog.find((m) => m.provider === lane.provider && m.model === lane.model);
      assert.ok(hit, `lane ${lane.provider}/${lane.model} must exist in registry`);
    }
    for (const l of plan.lanes) {
      assert.ok(typeof l.free === 'boolean');
      assert.ok(l.rank >= 0);
    }
  }
});

// ── liveProbe (non-blocking, never throws, mocked HTTP only) ─────────

test('liveProbe ok/unreachable via local stub; never throws on refused connection', async () => {
  const stub = http.createServer((req, res) => {
    assert.ok(req.url.startsWith('/models'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const reg = new ProviderRegistry();
  reg.get('openai').baseUrl = `http://127.0.0.1:${port}`;
  const ok = await reg.liveProbe('openai');
  assert.deepEqual(ok, { provider: 'openai', status: 'ok', ok: true });
  reg.get('openai').baseUrl = 'http://127.0.0.1:1'; // closed port
  const bad = await reg.liveProbe('openai', { timeoutMs: 500 });
  assert.equal(bad.status, 'unreachable');
  assert.equal((await reg.liveProbe('nope')).error, 'unknown_provider');
  await new Promise((r) => stub.close(r));
});

// ── HTTP surface ─────────────────────────────────────────────────────

test('GET /v2/providers: full set, no key material, 401 without token', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const un = await get(url, '/v2/providers', null);
    assert.equal(un.status, 401);
    const r = await get(url, '/v2/providers');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.providers.map((p) => p.name).sort(), [...EXPECTED_SET].sort());
    // allow-list projection only
    const allowed = ['name', 'kind', 'baseUrl', 'modelCount', 'defaultModel', 'status', 'lastProbeAt'];
    for (const p of body.providers) assert.deepEqual(Object.keys(p).sort(), [...allowed].sort());
    assert.ok(!/sk-/i.test(r.text), 'no sk- pattern in /v2/providers');
    assert.ok(!KEY_PATTERN.test(r.text), 'no key material in /v2/providers');
  } finally { await ctx.close(); }
});

test('GET /v2/providers/models: flat catalog, every row has provider+model, no keys', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await get(url, '/v2/providers/models');
    assert.equal(r.status, 200);
    const { models } = await r.json();
    assert.ok(models.length >= 17, 'dialagram alone contributes 17');
    for (const m of models) {
      assert.ok(EXPECTED_SET.includes(m.provider), `provider ${m.provider} is in the real set`);
      assert.ok(typeof m.model === 'string' && m.model.length > 0);
      assert.equal(typeof m.isDefault, 'boolean');
    }
    assert.ok(!KEY_PATTERN.test(r.text));
  } finally { await ctx.close(); }
});

test('POST /v2/providers/plan: free-tier-first over HTTP, audited, validates vs registry', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/providers/plan', { task: 'fix a bug in the router', preferFree: true });
    assert.equal(r.status, 200);
    const plan = await r.json();
    assert.deepEqual(plan.primary, { provider: 'ollama-cloud', model: 'glm-5.3-flash' });
    assert.ok(!KEY_PATTERN.test(r.text));
    // validate against an independent registry read
    const mr = await get(url, '/v2/providers/models');
    const catalog = (await mr.json()).models;
    for (const lane of [plan.primary, ...plan.fallbacks]) {
      assert.ok(catalog.some((m) => m.provider === lane.provider && m.model === lane.model));
    }
    // audited — and the audit entry carries no task text
    const planEntries = gw.chain.entries.filter((e) => e.payload.type === 'provider_plan');
    assert.ok(planEntries.length === 1);
    assert.equal(planEntries[0].payload.primary.provider, 'ollama-cloud');
    assert.ok(!('task' in planEntries[0].payload));
    // invalid body → 400
    assert.equal((await post(url, '/v2/providers/plan', null)).status, 400);
  } finally { await ctx.close(); }
});

test('POST /v2/providers/probe: mocked stub returns ok; unknown → 404; audited', async () => {
  const stub = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const gw = makeGateway();
  const reg = gw.providers; // attached below
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    // point the openai baseUrl at the stub via the registry singleton
    const { getRegistry } = require('../src/gateway/providers-singleton');
    getRegistry(gw).get('openai').baseUrl = `http://127.0.0.1:${port}`;
    const r = await post(url, '/v2/providers/probe', { provider: 'openai' });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.status, 'ok');
    assert.ok(!KEY_PATTERN.test(r.text));
    assert.ok(gw.chain.entries.some((e) => e.payload.type === 'provider_probe'));
    assert.equal((await post(url, '/v2/providers/probe', { provider: 'nope' })).status, 404);
  } finally {
    await ctx.close();
    await new Promise((r) => stub.close(r));
  }
});

test('GET /v2/providers?probe= : optional non-blocking probe wired over HTTP', async () => {
  const stub = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const { getRegistry } = require('../src/gateway/providers-singleton');
    getRegistry(gw).get('openai').baseUrl = `http://127.0.0.1:${port}`;
    const r = await get(url, '/v2/providers?probe=openai');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.probe.status, 'unreachable'); // 404 from stub → unreachable
    assert.ok(!KEY_PATTERN.test(r.text));
  } finally {
    await ctx.close();
    await new Promise((r) => stub.close(r));
  }
});

test('registry exposes gw.providers for mounts; singleton caches per gateway', () => {
  const gw = makeGateway();
  const { getRegistry } = require('../src/gateway/providers-singleton');
  const a = getRegistry(gw);
  const b = getRegistry(gw);
  assert.equal(a, b);
  assert.ok(Array.isArray(SEED) && SEED.length === 7);
});