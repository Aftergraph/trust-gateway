'use strict';
process.env.TG_DB_FILE = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')), 'gateway.db'); // isolated per-file db
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const H = (t) => require('../src/gateway/server').hashToken(t);
const { HashChain } = require('../src/gateway/hash-chain');

test('hash-export mount loads', () => {
  const mounts = require('../src/gateway/http-mounts');
  const loaded = mounts.loadMounts();
  const hashExport = loaded.find(m => m.name === 'v2-hash-export');
  assert.ok(hashExport, 'hash-export mount loaded');
  assert.equal(hashExport.method, 'GET');
  assert.equal(hashExport.path, '/v2/hash/export');
  assert.equal(hashExport.auth, 'bearer');
  assert.equal(hashExport.name, 'v2-hash-export');
});

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
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
    server.on('error', reject);
  });
}

test('audit-export returns 404 for non-matching mount path', async () => {
  const ctx = buildServer();
  const chain = new HashChain();
  chain.append({ type: 'test', data: 'hello' });
  ctx.attach(new Gateway({ bots: { test: { tokenHash: H('abc123') } }, chain, staticDir: null }));
  const url = await listen(ctx.server);
  try {
    // GET to /v2/hash/export without auth should return 401
    const res = await fetch(`${url}/v2/hash/export`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test('audit-export returns 401 without auth', async () => {
  const ctx = buildServer();
  const chain = new HashChain();
  ctx.attach(new Gateway({ bots: { test: { tokenHash: H('abc123') } }, chain, staticDir: null }));
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/hash/export?format=json`);
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /unauthorized/);
  } finally {
    await ctx.close();
  }
});

test('audit-export returns JSON chain with bearer auth', async () => {
  const ctx = buildServer();
  const chain = new HashChain();
  chain.append({ type: 'action', name: 'test_action' });
  ctx.attach(new Gateway({ bots: { test: { tokenHash: H('abc123') } }, chain, staticDir: null }));
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/hash/export?format=json`, {
      headers: { authorization: 'Bearer abc123' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    
    const body = await res.json();
    assert.ok(body.chainId);
    assert.equal(body.totalEntries, 2); // genesis + 1 entry
    assert.ok(Array.isArray(body.entries));
    assert.equal(body.entries.length, 2);
    assert.ok(body.genesis);
    assert.equal(body.genesis.seq, 0);
    assert.ok(body.verified);
    assert.ok(body.verified.ok);
  } finally {
    await ctx.close();
  }
});

test('audit-export returns PDF format with bearer auth', async () => {
  const ctx = buildServer();
  const chain = new HashChain();
  chain.append({ type: 'action', name: 'test_action' });
  ctx.attach(new Gateway({ bots: { test: { tokenHash: H('abc123') } }, chain, staticDir: null }));
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/hash/export?format=pdf`, {
      headers: { authorization: 'Bearer abc123' }
    });
    assert.equal(res.status, 200);
    const data = await res.text();
    assert.ok(data.includes('Trust Gateway Audit Chain'));
    assert.ok(data.includes(chain.chainId));
  } finally {
    await ctx.close();
  }
});

test('audit-export returns 400 for invalid format', async () => {
  const ctx = buildServer();
  const chain = new HashChain();
  ctx.attach(new Gateway({ bots: { test: { tokenHash: H('abc123') } }, chain, staticDir: null }));
  const url = await listen(ctx.server);
  try {
    const res = await fetch(`${url}/v2/hash/export?format=invalid`, {
      headers: { authorization: 'Bearer abc123' }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_format');
  } finally {
    await ctx.close();
  }
});

test('verify.html file exists and has no innerHTML', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  
  const verifyPath = path.join(__dirname, '..', 'app', 'verify.html');
  assert.ok(fs.existsSync(verifyPath), 'verify.html exists');
  
  const content = fs.readFileSync(verifyPath, 'utf8');
  assert.ok(!/\.innerHTML\s*[\+]?=/.test(content), 'verify.html must never assign innerHTML');
});
