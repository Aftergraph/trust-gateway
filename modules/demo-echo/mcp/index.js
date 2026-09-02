'use strict';
// demo-echo's registered MCP server stub (registry-level in wave A; the hub
// validates the manifest's mcp[] def — nothing spawns this yet).
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  try {
    const req = JSON.parse(l);
    const out = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'demo-echo-mcp', version: '1.0.0' } } };
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch { /* ignore malformed lines */ }
});
