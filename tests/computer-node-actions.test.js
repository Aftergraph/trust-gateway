'use strict';
process.env.TG_DB_FILE = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-db-')),
  'gateway.db',
);

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Gateway } = require('../src/gateway/server');

const NODE_TOKEN = 'n'.repeat(48);
const AUTHORITY_TOKEN = 'a'.repeat(48);

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-v02-actions-'));
  return path.join(dir, name);
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
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: [] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

async function call(base, method, p, { token = 'tok-atlas', body = null } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

function clearEnv() {
  delete process.env.TG_COMPUTER_NODE_URL;
  delete process.env.TG_COMPUTER_NODE_TOKEN;
  delete process.env.TG_COMPUTER_NODE_AUTHORITY_TOKEN;
  delete process.env.TG_COMPUTER_FILE;
}

test('computer v0.2: observation and effects use distinct transport/authority channels', async () => {
  const seenActions = [];
  const node = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${NODE_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/manifest') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [{
          id: 'native-windows-control',
          kind: 'native',
          version: '0.2.0',
          nodeId: 'jonas-lenovo',
          capabilities: [
            'computer.process.list',
            'computer.process.stop',
            'computer.files.read',
            'computer.files.write',
            'computer.shell.start',
            'computer.shell.send',
            'computer.shell.output',
            'computer.shell.stop',
          ],
        }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/action') {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw || '{}');
      seenActions.push({
        body,
        authority: req.headers['x-aftergraph-authority'] || null,
      });
      if (body.capability === 'computer.process.stop'
          && req.headers['x-aftergraph-authority'] !== AUTHORITY_TOKEN) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'effect_authority_required' }));
        return;
      }
      res.end(JSON.stringify({
        ok: true,
        capability: body.capability,
        output: body.capability === 'computer.process.list'
          ? { processes: [{ pid: 42, name: 'node.exe' }] }
          : { accepted: true },
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  process.env.TG_COMPUTER_NODE_URL = await listen(node);
  process.env.TG_COMPUTER_NODE_TOKEN = NODE_TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer.json');

  const gw = makeGateway();
  const gatewayServer = http.createServer((req, res) => gw.handle(req, res));
  const base = await listen(gatewayServer);

  try {
    const providers = await call(base, 'GET', '/v2/computer/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.body.providers[0].id, 'native-windows-control');

    const read = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.process.list',
        input: {},
      },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.ok, true);
    assert.equal(seenActions.length, 1);
    assert.equal(seenActions[0].authority, null);

    const withheldShell = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.shell.start',
        input: {},
      },
    });
    assert.equal(withheldShell.status, 409);
    assert.equal(withheldShell.body.error, 'capability_withheld_v02');
    assert.equal(seenActions.length, 1);

    const withheldWrite = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.files.write',
        input: { path: 'C:\\temp\\blocked.txt', content: 'NOPE' },
      },
    });
    assert.equal(withheldWrite.status, 409);
    assert.equal(withheldWrite.body.error, 'capability_withheld_v02');
    assert.equal(seenActions.length, 1);

    const deniedWorker = await call(base, 'POST', '/v2/computer/action', {
      token: 'tok-forge',
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.process.list',
        input: {},
      },
    });
    assert.equal(deniedWorker.status, 403);
    assert.equal(deniedWorker.body.error, 'operator_required');

    const session = await call(base, 'POST', '/v2/computer', {
      body: { label: 'v0.2 action proof' },
    });
    assert.equal(session.status, 201);
    const sessionId = session.body.session.id;

    const noAuthority = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.process.stop',
        sessionId,
        input: { pid: 9999 },
      },
    });
    assert.equal(noAuthority.status, 503);
    assert.equal(noAuthority.body.error, 'effect_authority_unconfigured');
    assert.equal(seenActions.length, 1);

    process.env.TG_COMPUTER_NODE_AUTHORITY_TOKEN = AUTHORITY_TOKEN;

    const effect = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.process.stop',
        sessionId,
        input: { pid: 9999 },
      },
    });
    assert.equal(effect.status, 200);
    assert.equal(effect.body.ok, true);
    assert.equal(seenActions.length, 2);
    assert.equal(seenActions[1].authority, AUTHORITY_TOKEN);

    const recorded = await call(base, 'GET', `/v2/computer/${encodeURIComponent(sessionId)}`);
    assert.equal(recorded.status, 200);
    assert.equal(recorded.body.frames.length, 1);
    assert.equal(recorded.body.frames[0].kind, 'action');
    assert.match(recorded.body.frames[0].summary, /computer\.process\.stop executed/);
    assert.ok(!JSON.stringify(recorded.body.frames[0]).includes('9999'));

    const actions = gw.chain.entries.map((entry) => entry.payload)
      .filter((payload) => payload && payload.type === 'computer_action');
    assert.ok(actions.some((entry) =>
      entry.capability === 'computer.process.list'
      && entry.effectful === false
      && entry.outcome === 'success'));
    assert.ok(actions.some((entry) =>
      entry.capability === 'computer.process.stop'
      && entry.effectful === true
      && entry.outcome === 'success'));
    assert.ok(actions.every((entry) => entry.input === undefined && entry.output === undefined));
    assert.equal(gw.chain.verify().ok, true);
  } finally {
    clearEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
  }
});

test('computer v0.2: effectful actions require a live ComputerSession', async () => {
  const node = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${NODE_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/manifest') {
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providers: [{
          id: 'native-windows-control',
          kind: 'native',
          version: '0.2.0',
          nodeId: 'jonas-lenovo',
          capabilities: ['computer.process.stop'],
        }],
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, capability: 'computer.process.stop', output: {} }));
  });

  process.env.TG_COMPUTER_NODE_URL = await listen(node);
  process.env.TG_COMPUTER_NODE_TOKEN = NODE_TOKEN;
  process.env.TG_COMPUTER_NODE_AUTHORITY_TOKEN = AUTHORITY_TOKEN;
  process.env.TG_COMPUTER_FILE = tmpFile('computer-session-required.json');

  const gw = makeGateway();
  const gatewayServer = http.createServer((req, res) => gw.handle(req, res));
  const base = await listen(gatewayServer);
  try {
    await call(base, 'GET', '/v2/computer/providers');
    const missing = await call(base, 'POST', '/v2/computer/action', {
      body: {
        providerId: 'native-windows-control',
        capability: 'computer.process.stop',
        input: { pid: 10 },
      },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'computer_session_required');
  } finally {
    clearEnv();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => node.close(resolve));
  }
});
