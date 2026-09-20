'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = '../src/gateway/works-context-client';
const ORIGINAL = {
  url: process.env.WORKS_API_URL,
  token: process.env.WORKS_API_TOKEN,
  bridge: process.env.WORKS_PLATFORM_BRIDGE_SECRET,
};

test.after(() => {
  for (const [key, value] of Object.entries({
    WORKS_API_URL: ORIGINAL.url,
    WORKS_API_TOKEN: ORIGINAL.token,
    WORKS_PLATFORM_BRIDGE_SECRET: ORIGINAL.bridge,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('execution PDR correlation sends bearer plus platform-bridge binding', async () => {
  process.env.WORKS_API_URL = 'http://works.test';
  process.env.WORKS_API_TOKEN = 'w'.repeat(48);
  process.env.WORKS_PLATFORM_BRIDGE_SECRET = 'b'.repeat(48);
  delete require.cache[require.resolve(MODULE)];
  const { recordExecutionPolicyDecision } = require(MODULE);

  let seen;
  const out = await recordExecutionPolicyDecision({
    workId: 'wrk_11111111111111111111111111111111',
    executionContextId: 'ctx_22222222222222222222222222222222',
    executionPdrId: 'pdr_33333333333333333333333333333333',
  }, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        status: 'recorded',
        evidence_id: 'evd_44444444444444444444444444444444',
        execution_context_id: 'ctx_22222222222222222222222222222222',
        execution_pdr_id: 'pdr_33333333333333333333333333333333',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(out.ok, true);
  assert.equal(seen.url, 'http://works.test/v1/works/wrk_11111111111111111111111111111111/evidence');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer worker-bearer');
  assert.equal(seen.init.headers['x-works-platform-bridge'], 'b'.repeat(48));
});

test('missing platform-bridge secret fails before network I/O', async () => {
  process.env.WORKS_API_URL = 'http://works.test';
  process.env.WORKS_API_TOKEN = 'w'.repeat(48);
  delete process.env.WORKS_PLATFORM_BRIDGE_SECRET;
  delete require.cache[require.resolve(MODULE)];
  const { recordExecutionPolicyDecision } = require(MODULE);

  let calls = 0;
  const out = await recordExecutionPolicyDecision({
    workId: 'wrk_11111111111111111111111111111111',
    executionContextId: 'ctx_22222222222222222222222222222222',
    executionPdrId: 'pdr_33333333333333333333333333333333',
  }, {
    fetchImpl: async () => { calls++; throw new Error('must not run'); },
  });

  assert.deepEqual(out, { ok: false, reason: 'works_bridge_unconfigured' });
  assert.equal(calls, 0);
});


test('missing WORKS bearer fails before network I/O', async () => {
  process.env.WORKS_API_URL = 'http://works.test';
  delete process.env.WORKS_API_TOKEN;
  process.env.WORKS_PLATFORM_BRIDGE_SECRET = 'b'.repeat(48);
  delete require.cache[require.resolve(MODULE)];
  const { recordExecutionPolicyDecision } = require(MODULE);

  let calls = 0;
  const out = await recordExecutionPolicyDecision({
    workId: 'wrk_11111111111111111111111111111111',
    executionContextId: 'ctx_22222222222222222222222222222222',
    executionPdrId: 'pdr_33333333333333333333333333333333',
  }, {
    fetchImpl: async () => { calls++; throw new Error('must not run'); },
  });

  assert.deepEqual(out, { ok: false, reason: 'works_auth_unconfigured' });
  assert.equal(calls, 0);
});
