#!/usr/bin/env node
'use strict';

const { createComputerMcpServer, parsePrefixes } = require('../src/gateway/computer-mcp');

const gatewayUrl = process.env.TG_GATEWAY_URL || 'http://127.0.0.1:8800';
const gatewayToken = process.env.TG_COMPUTER_MCP_GATEWAY_TOKEN || '';
const accessToken = process.env.AFTERGRAPH_COMPUTER_MCP_TOKEN || '';
const host = process.env.AFTERGRAPH_COMPUTER_MCP_HOST || '127.0.0.1';
const port = Number(process.env.AFTERGRAPH_COMPUTER_MCP_PORT || '8810');
const filePrefixes = parsePrefixes(process.env.AFTERGRAPH_COMPUTER_MCP_READ_PREFIXES || '');

if (!gatewayToken) {
  console.error('TG_COMPUTER_MCP_GATEWAY_TOKEN is required.');
  process.exit(2);
}
if (!accessToken || accessToken.length < 32) {
  console.error('AFTERGRAPH_COMPUTER_MCP_TOKEN must be at least 32 characters.');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('AFTERGRAPH_COMPUTER_MCP_PORT must be a valid port.');
  process.exit(2);
}

const server = createComputerMcpServer({ gatewayUrl, gatewayToken, accessToken, filePrefixes });
server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: 'aftergraph_computer_mcp_ready',
    host,
    port,
    endpoint: '/mcp',
    fileReadEnabled: filePrefixes.length > 0,
  }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
