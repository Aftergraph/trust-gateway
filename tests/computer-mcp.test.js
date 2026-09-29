'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  createComputerMcpServer,
  pathAllowed,
  toolCatalog,
} = require('../src/gateway/computer-mcp');

const ACCESS = 'a'.repeat(64);
const TG = 'operator-token';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}

async function rpc(base, body, token = ACCESS) {
  return fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

test('MCP catalog is read-only and file tool is opt-in', () => {
  assert.equal(toolCatalog().some((t) => t.name === 'aftergraph_computer_file_read'), false);
  const tools = toolCatalog({ filePrefixes: ['C:\\Aftergraph'] });
  assert.equal(tools.some((t) => t.name === 'aftergraph_computer_file_read'), true);
  assert.equal(tools.every((t) => t.annotations.readOnlyHint === true), true);
  assert.equal(pathAllowed('C:\\Aftergraph\\Home-OS\\VERSION', ['C:\\Aftergraph']), true);
  assert.equal(pathAllowed('C:\\Users\\empir\\secret.txt', ['C:\\Aftergraph']), false);
});

test('MCP facade authenticates and forwards only governed read surfaces', async (t) => {
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TG}`);
    if (req.method === 'GET' && req.url === '/v2/computer/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providers: [{ id: 'native-windows', capabilities: ['computer.health.inspect', 'computer.files.read'] }] }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (req.method === 'POST' && req.url === '/v2/computer/inspect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, findings: [], received: JSON.parse(body) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v2/computer/files/read') {
      const input = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nodeId: 'jonas-lenovo', providerId: 'native-windows', file: { path: input.path, text: 'v0.29', bytes: 5, truncated: false } }));
      return;
    }
    res.writeHead(404).end();
  });
  const gatewayBase = await listen(gateway);
  t.after(() => gateway.close());

  const mcp = createComputerMcpServer({
    gatewayUrl: gatewayBase,
    gatewayToken: TG,
    accessToken: ACCESS,
    filePrefixes: ['C:\\Aftergraph'],
  });
  const base = await listen(mcp);
  t.after(() => mcp.close());

  const unauthorized = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong');
  assert.equal(unauthorized.status, 401);

  const init = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'aftergraph-computer');

  const providers = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aftergraph_computer_providers', arguments: {} } });
  const providersBody = await providers.json();
  assert.equal(providersBody.result.isError, false);

  const read = await rpc(base, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'aftergraph_computer_file_read', arguments: { path: 'C:\\Aftergraph\\Home-OS\\VERSION' } },
  });
  const readBody = await read.json();
  assert.equal(readBody.result.structuredContent.nodeId, 'jonas-lenovo');
  assert.equal(readBody.result.structuredContent.file.text, 'v0.29');

  const denied = await rpc(base, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'aftergraph_computer_file_read', arguments: { path: 'C:\\Users\\empir\\secret.txt' } },
  });
  const deniedBody = await denied.json();
  assert.equal(deniedBody.result.isError, true);
  assert.equal(deniedBody.result.structuredContent.error, 'path_not_allowed_by_mcp');
});
