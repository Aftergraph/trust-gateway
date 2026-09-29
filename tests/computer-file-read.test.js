'use strict';
process.env.TG_DB_FILE = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tg-file-db-')),
  'gateway.db',
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Gateway } = require('../src/gateway/server');

const NODE_TOKEN = 'n'.repeat(48);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${server.address().port}`)));
}

function makeGateway() {
  return new Gateway({
    bots: {
      atlas: { name: 'atlas', token: 'tok-atlas', role: 'operator', capabilities: ['*'] },
      forge: { name: 'forge', token: 'tok-forge', role: 'worker', capabilities: ['fs.read'] },
    },
    dispatch: async () => ({ ok: true }),
  });
}

async function call(base, token, body) {
  const res = await fetch(base + '/v2/computer/files/read', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('governed file read requires operator and preserves file contents out of audit', async (t) => {
  let readCalls = 0;
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
          id: 'native-windows',
          kind: 'native',
          version: '0.2.0',
          nodeId: 'jonas-lenovo',
          capabilities: ['computer.health.inspect', 'computer.files.read'],
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/files/read') {
      readCalls += 1;
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const input = JSON.parse(raw);
      res.end(JSON.stringify({
        nodeId: 'jonas-lenovo',
        providerId: 'native-windows',
        file: {
          path: input.path,
          text: 'v0.29.0-frontier',
          bytes: 16,
          truncated: false,
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const nodeBase = await listen(node);
  t.after(() => node.close());

  process.env.TG_COMPUTER_NODE_URL = nodeBase;
  process.env.TG_COMPUTER_NODE_TOKEN = NODE_TOKEN;
  process.env.TG_COMPUTER_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-file-')), 'computer.json');
  t.after(() => {
    delete process.env.TG_COMPUTER_NODE_URL;
    delete process.env.TG_COMPUTER_NODE_TOKEN;
    delete process.env.TG_COMPUTER_FILE;
  });

  const gateway = makeGateway();
  const server = http.createServer((req, res) => gateway.handle(req, res));
  const base = await listen(server);
  t.after(() => server.close());

  const denied = await call(base, 'tok-forge', { path: 'C:\\Aftergraph\\Home-OS\\VERSION' });
  assert.equal(denied.status, 403);
  assert.equal(readCalls, 0);

  const ok = await call(base, 'tok-atlas', { path: 'C:\\Aftergraph\\Home-OS\\VERSION' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.nodeId, 'jonas-lenovo');
  assert.equal(ok.body.file.text, 'v0.29.0-frontier');
  assert.equal(readCalls, 1);

  const audits = gateway.chain.entries.map((entry) => entry.payload)
    .filter((payload) => payload && payload.type === 'computer_file_read');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].bot, 'atlas');
  assert.equal(typeof audits[0].pathHash, 'string');
  assert.equal(audits[0].pathHash.length, 64);
  assert.equal(audits[0].bytes, 16);
  assert.equal(audits[0].truncated, false);
  assert.equal(audits[0].path, undefined);
  assert.equal(JSON.stringify(audits[0]).includes('v0.29.0-frontier'), false);
});
