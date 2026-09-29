'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

const PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY = 256 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function validateGatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('bad_gateway_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('bad_gateway_url');
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new Error('gateway_tls_required');
  return url.toString().replace(/\/$/, '');
}

function parsePrefixes(value) {
  return String(value || '').split(';').map((v) => v.trim()).filter(Boolean);
}

function pathAllowed(path, prefixes) {
  if (!prefixes.length) return false;
  const candidate = String(path || '').toLowerCase();
  return prefixes.some((prefix) => {
    const base = prefix.replace(/[\\/]+$/, '').toLowerCase();
    return candidate === base || candidate.startsWith(base + '\\') || candidate.startsWith(base + '/');
  });
}

function toolCatalog({ filePrefixes = [] } = {}) {
  const tools = [
    {
      name: 'aftergraph_computer_providers',
      title: 'Aftergraph Computer Providers',
      description: 'List sanitized Computer Node provider metadata through Trust Gateway.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'aftergraph_computer_health',
      title: 'Aftergraph Computer Health',
      description: 'Inspect Jonas-Lenovo/Computer Node health through the governed Trust Gateway boundary.',
      inputSchema: {
        type: 'object',
        properties: {
          depth: { type: 'string', enum: ['quick', 'standard', 'forensic'], default: 'standard' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
  if (filePrefixes.length) {
    tools.push({
      name: 'aftergraph_computer_file_read',
      title: 'Aftergraph Computer File Read',
      description: 'Read bounded UTF-8 text from explicitly allowlisted host paths through Trust Gateway and Computer Node.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          maxBytes: { type: 'integer', minimum: 1, maximum: 262144, default: 65536 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  }
  return tools;
}

function mcpResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(typeof value === 'object' && value !== null ? { structuredContent: value } : {}),
    isError,
  };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('body_too_large');
  }
  if (!body) throw new Error('empty_body');
  return JSON.parse(body);
}

async function gatewayFetch(baseUrl, gatewayToken, path, options = {}) {
  const res = await fetch(baseUrl + path, {
    ...options,
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      accept: 'application/json',
      ...(options.headers || {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  let body = null;
  try { body = await res.json(); } catch { body = { error: 'non_json_gateway_response' }; }
  if (!res.ok) {
    const error = new Error(body && body.error ? String(body.error) : `gateway_http_${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function createComputerMcpHandler({
  gatewayUrl,
  gatewayToken,
  accessToken,
  filePrefixes = [],
  serverName = 'aftergraph-computer',
} = {}) {
  const baseUrl = validateGatewayUrl(gatewayUrl);
  if (!gatewayToken) throw new Error('gateway_token_required');
  if (!accessToken || String(accessToken).length < 32) throw new Error('access_token_too_short');
  const tools = toolCatalog({ filePrefixes });

  async function callTool(name, args) {
    if (name === 'aftergraph_computer_providers') {
      return gatewayFetch(baseUrl, gatewayToken, '/v2/computer/providers', { method: 'GET' });
    }
    if (name === 'aftergraph_computer_health') {
      const depth = args && typeof args.depth === 'string' ? args.depth : 'standard';
      if (!['quick', 'standard', 'forensic'].includes(depth)) throw new Error('bad_depth');
      return gatewayFetch(baseUrl, gatewayToken, '/v2/computer/inspect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'health', depth }),
      });
    }
    if (name === 'aftergraph_computer_file_read') {
      if (!filePrefixes.length) throw new Error('file_read_disabled');
      const path = args && typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) throw new Error('path_required');
      if (!pathAllowed(path, filePrefixes)) throw new Error('path_not_allowed_by_mcp');
      const maxBytes = args && Number.isFinite(args.maxBytes) ? Math.floor(args.maxBytes) : 64 * 1024;
      if (maxBytes < 1 || maxBytes > 256 * 1024) throw new Error('bad_max_bytes');
      return gatewayFetch(baseUrl, gatewayToken, '/v2/computer/files/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, maxBytes }),
      });
    }
    throw new Error('unknown_tool');
  }

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://mcp.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const payload = JSON.stringify({ ok: true, service: serverName, tools: tools.length });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(payload);
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!auth || !safeEqual(auth[1], accessToken)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="aftergraph-computer"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let rpc;
    try { rpc = await readJson(req); }
    catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }

    const id = rpc && Object.prototype.hasOwnProperty.call(rpc, 'id') ? rpc.id : null;
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(rpcError(id, -32600, 'Invalid Request')));
      return;
    }

    let response;
    try {
      if (rpc.method === 'initialize') {
        response = {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: '0.1.0' },
          },
        };
      } else if (rpc.method === 'ping') {
        response = { jsonrpc: '2.0', id, result: {} };
      } else if (rpc.method === 'tools/list') {
        response = { jsonrpc: '2.0', id, result: { tools } };
      } else if (rpc.method === 'tools/call') {
        const params = rpc.params && typeof rpc.params === 'object' ? rpc.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          const value = await callTool(name, args);
          response = { jsonrpc: '2.0', id, result: mcpResult(value) };
        } catch (e) {
          response = {
            jsonrpc: '2.0',
            id,
            result: mcpResult({
              error: String(e && e.message ? e.message : e),
              ...(e && e.status ? { status: e.status } : {}),
            }, true),
          };
        }
      } else if (rpc.method.startsWith('notifications/')) {
        res.writeHead(202, { 'cache-control': 'no-store' });
        res.end();
        return;
      } else {
        response = rpcError(id, -32601, 'Method not found');
      }
    } catch (e) {
      response = rpcError(id, -32603, 'Internal error');
    }

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(response));
  };
}

function createComputerMcpServer(options) {
  const handler = createComputerMcpHandler(options);
  return http.createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });
}

module.exports = {
  PROTOCOL_VERSION,
  validateGatewayUrl,
  parsePrefixes,
  pathAllowed,
  toolCatalog,
  createComputerMcpHandler,
  createComputerMcpServer,
};
