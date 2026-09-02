#!/usr/bin/env node
'use strict';
// Entry point: start the Trust Gateway HTTP server.
// Env:
//   PORT          (default 8800)
//   BOT_TOKENS    comma-separated name:token pairs, e.g. "forge:s3cret,atlas:op-s3cret"
//   BOT_CAPS      optional per-bot caps JSON: {"forge":["fs.read","fs.write:*"]}

const http = require('node:http');
const { Gateway } = require('../src/gateway/server');

function parseBots() {
  const bots = {};
  const pairs = (process.env.BOT_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let caps = {};
  try { caps = JSON.parse(process.env.BOT_CAPS || '{}'); } catch { /* default caps */ }
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx);
    const token = pair.slice(idx + 1);
    bots[name] = { token, role: 'worker', capabilities: caps[name] || ['fs.read', 'web.get'] };
  }
  return bots;
}

const bots = parseBots();
if (Object.keys(bots).length === 0) {
  console.error('No bots configured. Set BOT_TOKENS="name:token,name2:token2".');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8800);
const DISPATCH = process.argv.includes('--dispatch');
const gw = new Gateway({
  bots,
  dispatch: DISPATCH
    ? async (tool, args) => {
        // v1 demo dispatcher: safe in-memory filesystem + echo shell.
        const files = global.__gwFiles || (global.__gwFiles = new Map());
        if (tool.startsWith('fs.write:')) {
          const p = tool.slice('fs.write:'.length);
          files.set(p, args && args.content ? args.content : '');
          return { wrote: p, bytes: Buffer.byteLength(String((args && args.content) || '')) };
        }
        if (tool.startsWith('fs.read:')) {
          const p = tool.slice('fs.read:'.length);
          return { path: p, content: files.get(p) ?? null };
        }
        if (tool === 'shell.run') return { ran: args && args.cmd, exitCode: 0 }; // demo only — v2 runs real sandbox
        return { tool, done: true };
      }
    : null,
});

const server = http.createServer((req, res) => gw.handle(req, res));
server.listen(PORT, () => {
  console.log(`▲ trust-gateway listening on :${PORT} with bots: ${Object.keys(bots).join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const v = gw.chain.verify();
    console.log(`\nshutting down — audit chain verified: ${v.ok ? 'OK' : 'TAMPERED'}`);
    server.close(() => process.exit(0));
  });
}