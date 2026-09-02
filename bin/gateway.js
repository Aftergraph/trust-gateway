#!/usr/bin/env node
'use strict';
// Entry point: start the Trust Gateway HTTP server.
// Env:
//   PORT          (default 8800)
//   BOT_TOKENS    comma-separated name:token pairs, e.g. "forge:s3cret,atlas:op-s3cret"
//   BOT_CAPS      optional per-bot caps JSON: {"forge":["fs.read","fs.write:*"]}
//   BOTS_DIR      root under which per-bot jailed dirs are created (default data/bots)
//   --dispatch    enable the per-bot jailed dispatcher (src/gateway/dispatcher.js)

const http = require('node:http');
const path = require('node:path');
const { Gateway } = require('../src/gateway/server');
const { makeDispatcher } = require('../src/gateway/dispatcher');

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
    // RBAC: 'atlas' is the operator (may approve/deny). 'forge' (and anything
    // else) is a worker — fails closed on approval endpoints. Override with
    // BOT_ROLES (JSON map) for custom deployments.
    let roles = {};
    try { roles = JSON.parse(process.env.BOT_ROLES || '{}'); } catch { /* default roles */ }
    const defaultRole = name === 'atlas' ? 'operator' : 'worker';
    const role = roles[name] ?? defaultRole;
    bots[name] = { token, role, capabilities: caps[name] || ['fs.read', 'web.get'] };
  }
  return bots;
}

const bots = parseBots();
if (Object.keys(bots).length === 0) {
  console.error('No bots configured. Set BOT_TOKENS="name:token,name2:token2".');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8800);
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(__dirname, '..', 'data', 'audit.jsonl');
const APPROVALS_FILE = process.env.APPROVALS_FILE || path.join(__dirname, '..', 'data', 'approvals.json');
const DISPATCH = process.argv.includes('--dispatch');
const gw = new Gateway({
  bots,
  auditFile: AUDIT_FILE,
  approvalsFile: APPROVALS_FILE,
  dispatch: DISPATCH
    ? makeDispatcher({ botsDir: process.env.BOTS_DIR || path.join(__dirname, '..', 'data', 'bots') })
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