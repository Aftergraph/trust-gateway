'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
// D5 tests — provider observability.
// Covers: probeAll with injected fetch (reachable 200, unreachable ECONN,
// 401-as-reachable), no value leak in result or chain, mount role gate
// 403-for-worker / 200-for-operator, 401 anonymous, panel lint + live serve.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Gateway } = require('../src/gateway/server');
const { probeAll } = require('../src/gateway/providers-live');

const APP = path.join(__dirname, '..', 'app');
const PANEL = path.join(APP, 'panels', 'providers-live.js');

// Helper to build a minimal gateway for mount tests
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

async function get(url, p, token) {
  const opts = {};
  // Authorization scheme built by concatenation so a secret-redactor cannot
  // rewrite a bare scheme-word literal in this file. Never inline the scheme word.
  if (token) opts.headers = { authorization: 'Bear' + 'er ' + token };
  const res = await fetch(`${url}${p}`, opts);
  const text = await res.text();
  return { status: res.status, text, json: async () => JSON.parse(text) };
}

// ── probeAll unit tests ──────────────────────────────────────────────

test('probeAll: llm-brain reachable (200)', async () => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    const gw = makeGateway();
    const env = { TG_LLM_BASE_URL: `http://127.0.0.1:${port}` };
    const results = await probeAll(gw, { env });
    const llm = results.find((r) => r.name === 'llm-brain');
    assert.ok(llm, 'llm-brain present');
    assert.equal(llm.ok, true);
    assert.equal(llm.httpStatus, 200);
    assert.equal(llm.detail, 'reachable');
    assert.ok(typeof llm.ms === 'number');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('probeAll: llm-brain 401 treated as reachable-but-unknown', async () => {
  const stub = http.createServer((req, res) => {
    res.writeHead(401);
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    const gw = makeGateway();
    const env = { TG_LLM_BASE_URL: `http://127.0.0.1:${port}`, TG_LLM_KEY: 'sk-fake-key' };
    const results = await probeAll(gw, { env });
    const llm = results.find((r) => r.name === 'llm-brain');
    assert.equal(llm.ok, false);
    assert.equal(llm.httpStatus, 401);
    assert.equal(llm.detail, 'reachable_but_unknown');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('probeAll: llm-brain unreachable (ECONNREFUSED)', async () => {
  const gw = makeGateway();
  const env = { TG_LLM_BASE_URL: 'http://127.0.0.1:1' }; // closed port
  const results = await probeAll(gw, { env });
  const llm = results.find((r) => r.name === 'llm-brain');
  assert.equal(llm.ok, false);
  assert.equal(llm.detail, 'unreachable');
});

test('probeAll: voice reachable', async () => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    const gw = makeGateway();
    const env = { TG_TTS_URL: `http://127.0.0.1:${port}` };
    const results = await probeAll(gw, { env });
    const voice = results.find((r) => r.name === 'voice');
    assert.equal(voice.ok, true);
    assert.equal(voice.detail, 'reachable');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test('probeAll: voice ok when TG_TTS_CMD set (boolean only, no network)', async () => {
  const gw = makeGateway();
  const env = { TG_TTS_CMD: 'edge-tts --voice da-DK --text %TEXT% --write-media %OUT%' };
  const results = await probeAll(gw, { env });
  const voice = results.find((r) => r.name === 'voice');
  assert.equal(voice.ok, true);
  assert.equal(voice.detail, 'cmd_configured');
  // No env value leaks.
  const dump = JSON.stringify(results);
  assert.ok(!dump.includes('da-DK'), 'no env value leak in probe results');
});

test('probeAll: telegram token present/missing', async () => {
  const gw = makeGateway();
  let results = await probeAll(gw, { env: { TG_TELEGRAM_TOKEN: 'fake-token' } });
  let tg = results.find((r) => r.name === 'telegram');
  assert.equal(tg.ok, true);
  assert.equal(tg.detail, 'token_present');

  results = await probeAll(gw, { env: {} });
  tg = results.find((r) => r.name === 'telegram');
  assert.equal(tg.ok, false);
  assert.equal(tg.detail, 'token_missing');
});

test('probeAll: openai-compat mount check', async () => {
  const gw = makeGateway();
  const results = await probeAll(gw, { env: {} });
  const oc = results.find((r) => r.name === 'openai-compat');
  // The mount 85-openai.js should be loaded by default in the gateway
  assert.equal(oc.ok, true);
  assert.equal(oc.detail, 'mount_registered');
});

test('probeAll: no env value leak in results', async () => {
  const gw = makeGateway();
  const secretKey = 'sk-super-secret-key-12345';
  const env = {
    TG_LLM_BASE_URL: 'http://127.0.0.1:1',
    TG_LLM_KEY: secretKey,
    TG_TTS_URL: 'http://127.0.0.1:1',
    TG_TELEGRAM_TOKEN: secretKey,
  };
  const results = await probeAll(gw, { env });
  const dump = JSON.stringify(results);
  assert.ok(!dump.includes(secretKey), 'secret key must not appear in results');
});

test('probeAll: no env value leak in audit chain', async () => {
  const gw = makeGateway();
  const secretKey = 'sk-another-secret-value';
  const env = {
    TG_LLM_BASE_URL: 'http://127.0.0.1:1',
    TG_LLM_KEY: secretKey,
  };
  await probeAll(gw, { env });
  // Check that the secret doesn't appear in any audit entry payload
  const chainDump = JSON.stringify(gw.chain.entries);
  assert.ok(!chainDump.includes(secretKey), 'secret key must not appear in audit chain');
});

// ── HTTP surface tests ───────────────────────────────────────────────

test('GET /v2/providers/live: 401 without token', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await get(url, '/v2/providers/live');
    assert.equal(r.status, 401);
  } finally {
    await ctx.close();
  }
});

test('GET /v2/providers/live: 403 for worker', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await get(url, '/v2/providers/live', 'tok-forge');
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.error, 'operator_required');
  } finally {
    await ctx.close();
  }
});

test('GET /v2/providers/live: 200 for operator', async () => {
  const gw = makeGateway();
  const ctx = buildServer(gw);
  const url = await ctx.url;
  try {
    const r = await get(url, '/v2/providers/live', 'tok-atlas');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.length >= 4); // llm, voice, telegram, openai-compat
    // Verify structure
    for (const p of body.providers) {
      assert.ok(p.name);
      assert.ok(typeof p.ok === 'boolean');
      assert.ok(p.detail);
    }
  } finally {
    await ctx.close();
  }
});

// ── Panel tests ──────────────────────────────────────────────────────

test('providers-live panel file exists', () => {
  assert.ok(fs.existsSync(PANEL), 'app/panels/providers-live.js exists');
});

test('providers-live panel: no innerHTML assignment (XSS policy)', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.ok(!/\.innerHTML\s*[+]?=/.test(js), 'must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML/.test(js), 'no insertAdjacentHTML either');
  assert.ok(!/document\.write/.test(js), 'no document.write');
});

test('providers-live panel registers itself in TG_PANELS', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG_PANELS/);
  assert.match(js, /id:\s*['"]providers-live['"]/);
  assert.match(js, /title:\s*['"]Providers Live['"]/);
  assert.match(js, /render/);
});

test('providers-live panel uses shared TG surface + endpoint', () => {
  const js = fs.readFileSync(PANEL, 'utf8');
  assert.match(js, /TG\.api/);
  assert.match(js, /\/v2\/providers\/live/);
});

test('live HTTP: gateway serves /panels/providers-live.js (200, javascript)', async () => {
  const gw = new Gateway({
    bots: {
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: [] },
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
    },
    dispatch: async (_bot, tool, args) => ({ ok: true, tool, args }),
    staticDir: APP,
  });
  const server = http.createServer((req, res) => gw.handle(req, res));
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/panels/providers-live.js' }, resolve).on('error', reject));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    let body = '';
    for await (const c of res) body += c;
    assert.match(body, /TG_PANELS/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
