#!/usr/bin/env node
'use strict';
// Live demo: start gateway, run a full bot-workflow through real HTTP:
// read → write → destructive → approval → execute → audit verify → tamper check.

const http = require('node:http');
const { Gateway } = require('../src/gateway/server');
const { HashChain } = require('../src/gateway/hash-chain');

const PORT = 8791;
const fsFiles = new Map(); // fake filesystem for the demo dispatcher

const gw = new Gateway({
  bots: {
    forge: { token: 'demo-forge-token', role: 'worker', capabilities: ['fs.read', 'fs.write:*', 'web.get'] },
    atlas: { token: 'demo-atlas-token', role: 'operator', capabilities: ['*'] },
  },
  dispatch: async (tool, args) => {
    if (tool.startsWith('fs.write:')) {
      const path = tool.slice('fs.write:'.length);
      fsFiles.set(path, args && args.content ? args.content : '');
      return { wrote: path, bytes: Buffer.byteLength(String(args && args.content || '')) };
    }
    if (tool.startsWith('fs.read:')) {
      const path = tool.slice('fs.read:'.length);
      return { path, content: fsFiles.get(path) ?? null };
    }
    if (tool === 'shell.run') return { ran: args && args.cmd, exitCode: 0 };
    return { tool, done: true };
  },
});

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(PORT, r));
  console.log(`▲ trust-gateway listening on :${PORT}`);

  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '✔' : '✖'} ${name}${extra ? '  → ' + extra : ''}`);
    if (!cond) failures++;
  };

  // 1. Auth rejected
  const anon = await call('POST', '/v1/actions', { tool: 'fs.read:x' }, null);
  check('unauthenticated → 401', anon.status === 401);

  // 2. Read flows
  const read = await call('POST', '/v1/actions', { tool: 'fs.read:notes/x.md' }, 'demo-forge-token');
  check('read allowed', read.status === 200 && read.body.decision === 'allow');

  // 3. Write with capability
  const write = await call('POST', '/v1/actions', { tool: 'fs.write:out/hello.txt', args: { content: 'hello AVC' } }, 'demo-forge-token');
  check('write (capability) executed', write.status === 200 && write.body.result.wrote === 'out/hello.txt');

  // 4. Destructive → needs approval, NOT executed
  const shell = await call('POST', '/v1/actions', { tool: 'shell.run', args: { cmd: 'deploy.sh' } }, 'demo-forge-token');
  check('destructive → 202 needs_approval', shell.status === 202);
  check('destructive NOT executed', !shell.body.result);
  const aprId = shell.body.approvalId;

  // 5. Deny path first (second request)
  const shell2 = await call('POST', '/v1/actions', { tool: 'fs.delete:data' }, 'demo-forge-token');
  const deny = await call('POST', `/v1/approvals/${shell2.body.approvalId}/deny`, null, 'demo-atlas-token');
  check('deny blocks execution', deny.status === 200);

  // 6. Approve → executed
  const approve = await call('POST', `/v1/approvals/${aprId}/approve`, null, 'demo-atlas-token');
  check('approve → executed', approve.status === 200 && approve.body.result && approve.body.result.exitCode === 0);

  // 7. Secret args never in audit
  await call('POST', '/v1/actions', { tool: 'fs.write:vault.txt', args: { content: 'TOKEN=super-secret-value-123' } }, 'demo-forge-token');
  const auditRaw = JSON.stringify(gw.chain.entries);
  check('secret value NOT in audit', !auditRaw.includes('super-secret-value-123'));

  // 8. Audit chain verifies
  const v1 = await call('GET', '/v1/audit/verify', null, 'demo-forge-token');
  check('audit chain verifies', v1.body.ok === true && v1.body.length > 5, `length=${v1.body.length}`);

  // 9. TAMPER TEST: mutate a historical entry in memory → verify fails
  const victim = gw.chain.entries[2];
  const before = JSON.stringify(victim.payload);
  victim.payload.decision = victim.payload.decision === 'allow' ? 'deny' : 'allow'; // attacker rewrites history!
  if (JSON.stringify(victim.payload) === before) victim.payload.forged = true; // ensure actual change
  const v2 = gw.chain.verify();
  check('tampering detected', v2.ok === false, `at seq ${v2.at} (${v2.reason})`);

  // 10. healthz
  const health = await call('GET', '/healthz', null, null);
  check('healthz (no auth)', health.status === 200);

  console.log(failures === 0 ? '\n★ DEMO PASSED — all checks green' : `\n✖ ${failures} check(s) failed`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });