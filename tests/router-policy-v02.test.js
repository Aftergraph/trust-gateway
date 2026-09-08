'use strict';
process.env.TG_DB_FILE = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')),
  'gateway.db',
);

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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(url, path, body, token = 'tok-atlas') {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: () => JSON.parse(text) };
}

async function withGateway(fn) {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    await fn({ gw, url });
  } finally {
    await ctx.close();
  }
}

test('policy-aware route fails closed on invalid restrictive fields', async () => {
  const invalidBodies = [
    [{ execution_mode: 'fastest' }, 'invalid_execution_mode'],
    [{ data_class: 'secret-ish', provider_training_allowed: false }, 'invalid_data_class'],
    [{ data_class: 'public', provider_training_allowed: 'yes' }, 'invalid_provider_training_allowed'],
    [{ data_class: 'public', provider_training_allowed: false, max_cost_usd: -1 }, 'invalid_max_cost_usd'],
    [{ data_class: 'public', provider_training_allowed: false, max_cost_usd: Number.POSITIVE_INFINITY }, 'invalid_max_cost_usd'],
    [{ data_class: 'public', provider_training_allowed: false, execution_context_id: 'ctx_bad' }, 'invalid_execution_context_id'],
  ];

  for (const [body, expectedError] of invalidBodies) {
    await withGateway(async ({ url }) => {
      const r = await post(url, '/v2/router/route', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json().error, expectedError);
    });
  }
});

test('policy-aware route requires explicit data class and training permission', async () => {
  await withGateway(async ({ url }) => {
    const missingDataClass = await post(url, '/v2/router/route', {
      execution_mode: 'auto',
      provider_training_allowed: false,
    });
    assert.equal(missingDataClass.status, 400);
    assert.equal(missingDataClass.json().error, 'data_class_required');

    const missingPermission = await post(url, '/v2/router/route', {
      execution_mode: 'auto',
      data_class: 'public',
    });
    assert.equal(missingPermission.status, 400);
    assert.equal(missingPermission.json().error, 'provider_training_allowed_required');
  });
});

test('legacy capability + budget_tier route remains byte-shape compatible', async () => {
  await withGateway(async ({ url }) => {
    const r = await post(url, '/v2/router/route', { capability: 'code', budget_tier: 'free' });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.provider, 'ollama-cloud');
    assert.equal(body.model, 'glm-5.3-flash');
    assert.ok(Array.isArray(body.fallbacks));
    assert.equal(body.receipt, undefined);
  });
});

test('provider registry exposes direct Meta Model API Spark 1.3 routes', () => {
  const gw = makeGateway();
  const models = getRegistry(gw).models();
  assert.ok(models.some((x) => x.provider === 'meta-model-api' && x.model === 'muse-spark-1.3'));
  assert.ok(models.some((x) => x.provider === 'meta-model-api' && x.model === 'muse-spark-1.3-contributor'));
});

test('route catalog distinguishes Spark Contributor data use and price from standard', () => {
  const { getRouteModel } = require('../src/gateway/model-route-catalog');
  const contributor = getRouteModel('meta-model-api', 'muse-spark-1.3-contributor');
  assert.ok(contributor);
  assert.equal(contributor.dataUse, 'provider_training');
  assert.equal(contributor.pricing.inputPerMtokUsd, 0.10);
  assert.equal(contributor.pricing.outputPerMtokUsd, 0.20);
  assert.equal(contributor.pricing.cacheReadPerMtokUsd, 0.002);

  const standard = getRouteModel('meta-model-api', 'muse-spark-1.3');
  assert.ok(standard);
  assert.equal(standard.dataUse, 'no_provider_training');
});

test('policy-aware public code route prefers Contributor only with explicit training permission', async () => {
  await withGateway(async ({ url }) => {
    const r = await post(url, '/v2/router/route', {
      capability: 'code',
      execution_mode: 'auto',
      data_class: 'public',
      provider_training_allowed: true,
      max_cost_usd: 2,
    });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.provider, 'meta-model-api');
    assert.equal(body.model, 'muse-spark-1.3-contributor');
  });
});

test('policy-aware public code route excludes Contributor when training permission is false', async () => {
  await withGateway(async ({ url }) => {
    const r = await post(url, '/v2/router/route', {
      capability: 'code',
      execution_mode: 'auto',
      data_class: 'public',
      provider_training_allowed: false,
      max_cost_usd: 10,
    });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.provider, 'meta-model-api');
    assert.equal(body.model, 'muse-spark-1.3');
    assert.ok(!body.fallbacks.some((x) => x.model === 'muse-spark-1.3-contributor'));
  });
});

test('restricted data excludes Contributor even when caller permits provider training', async () => {
  await withGateway(async ({ url }) => {
    const r = await post(url, '/v2/router/route', {
      capability: 'code',
      execution_mode: 'auto',
      data_class: 'restricted',
      provider_training_allowed: true,
      max_cost_usd: 10,
    });
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.provider, 'meta-model-api');
    assert.equal(body.model, 'muse-spark-1.3');
    assert.ok(!body.fallbacks.some((x) => x.model === 'muse-spark-1.3-contributor'));
  });
});

test('policy-aware route fails closed when budget leaves no eligible route', async () => {
  await withGateway(async ({ url }) => {
    const r = await post(url, '/v2/router/route', {
      capability: 'code',
      execution_mode: 'auto',
      data_class: 'public',
      provider_training_allowed: true,
      max_cost_usd: 0,
    });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'no_eligible_route');
  });
});
