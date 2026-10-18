'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// Model Router tests — routing selection based on constraints.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { getRegistry } = require('../src/gateway/providers-singleton');

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

async function post(url, p, body, token = 'tok-atlas') {
  const res = await fetch(`${url}${p}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

async function postRaw(url, p, rawBody, token = 'tok-atlas') {
  const res = await fetch(`${url}${p}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

test('POST /v2/router/route: capability + budget_tier selection', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code', budget_tier: 'free' });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(result.model);
    assert.ok(result.provider);
    assert.ok(Array.isArray(result.fallbacks));
    // free tier: primary should be free model
    assert.equal(result.provider, 'ollama-cloud');
    assert.equal(result.model, 'glm-5.3-flash');
    // audit recorded
    const routeEntries = gw.chain.entries.filter((e) => e.payload.type === 'model_route');
    assert.equal(routeEntries.length, 1);
    assert.equal(routeEntries[0].payload.capabilityTag, 'code');
    assert.equal(routeEntries[0].payload.budgetTier, 'free');
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: premium tier includes more options', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'reasoning', budget_tier: 'premium' });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(result.model);
    assert.ok(result.provider);
    // premium gets more fallbacks
    assert.ok(result.fallbacks.length <= 3);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: invalid JSON returns 400', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await postRaw(url, '/v2/router/route', 'not json');
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: no auth returns 401', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code' }, null);
    assert.equal(r.status, 401);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: empty body defaults work', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', {});
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(result.model);
    assert.ok(result.provider);
  } finally {
    await ctx.close();
  }
});

// ── Verified Auto Phase 0: advisory policy fields ──

test('POST /v2/router/route: verified mode emits receipt with verification_required', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', {
      capability: 'code',
      budget_tier: 'economy',
      execution_mode: 'verified',
      data_class: 'public',
      provider_training_allowed: true,
      max_cost_usd: 2.0,
      verification: 'exact_head',
      execution_context_id: 'ctx_0123456789abcdef0123456789abcdef',
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.ok(result.receipt);
    assert.equal(result.receipt.schema, 'model-route/1.0');
    assert.ok(result.receipt.route_id.startsWith('rte_'));
    assert.equal(result.receipt.execution_mode, 'verified');
    assert.equal(result.receipt.verification_required, true);
    assert.equal(result.receipt.data_class, 'public');
    assert.equal(result.receipt.provider_training_allowed, true);
    assert.equal(result.receipt.max_cost_usd, 2.0);
    assert.equal(result.receipt.verification, 'exact_head');
    assert.equal(result.receipt.execution_context_id, 'ctx_0123456789abcdef0123456789abcdef');
    assert.ok(result.receipt.reason_codes.includes('capability_match'));
    assert.ok(result.receipt.reason_codes.includes('cost_ceiling_enforced'));
    assert.ok(result.receipt.reason_codes.includes('provider_training_permitted'));
    // legacy fields unchanged
    assert.ok(result.model);
    assert.ok(result.provider);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: auto mode does not require verification', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code', execution_mode: 'auto' });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.equal(result.receipt.execution_mode, 'auto');
    assert.equal(result.receipt.verification_required, false);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: invalid execution_mode fails closed', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code', execution_mode: 'economy' });
    assert.equal(r.status, 400);
    const result = await r.json();
    assert.equal(result.error, 'invalid_execution_mode');
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: invalid data_class fails closed', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code', data_class: 'topsecret' });
    assert.equal(r.status, 400);
    const result = await r.json();
    assert.equal(result.error, 'invalid_data_class');
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: confidential data class denied, not silently treated as public', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    for (const dataClass of ['confidential', 'restricted']) {
      const r = await post(url, '/v2/router/route', { capability: 'code', data_class: dataClass });
      assert.equal(r.status, 403);
      const result = await r.json();
      assert.equal(result.error, 'route_policy_denied');
    }
    const denied = gw.chain.entries.filter((e) => e.payload.type === 'model_route_denied');
    assert.equal(denied.length, 2);
  } finally {
    await ctx.close();
  }
});

test('POST /v2/router/route: non-boolean training flag fails closed', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await post(url, '/v2/router/route', { capability: 'code', provider_training_allowed: 'yes' });
    assert.equal(r.status, 400);
    const result = await r.json();
    assert.equal(result.error, 'invalid_provider_training_allowed');
  } finally {
    await ctx.close();
  }
});
