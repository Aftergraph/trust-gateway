'use strict';
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
