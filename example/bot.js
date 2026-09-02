'use strict';
// Example bot — Trust Gateway client SDK demo.
//
// Self-contained workflow:
//   read  → write (capability) → needs_approval → human-in-the-loop approve
//
// Reads GATEWAY_URL / GATEWAY_TOKEN from env. No dependencies beyond the SDK.
//
//   GATEWAY_URL=http://127.0.0.1:8800 GATEWAY_TOKEN=tok-forge node example/bot.js

const { GatewayClient } = require('../src/gateway/client');

const BASE_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8800';
const TOKEN = process.env.GATEWAY_TOKEN || 'tok-forge';

function log(step, label, data) {
  console.log(`[${step}] ${label}`);
  if (data !== undefined && data !== null) console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const gw = new GatewayClient({ baseUrl: BASE_URL, token: TOKEN });
  log(0, `Trust Gateway demo at ${BASE_URL} (bot token in env)`);

  // 1. Read — a read action, auto-allowed by policy.
  const readRes = await gw.action('fs.read:notes/x.md');
  log(1, 'read notes/x.md', { decision: readRes.decision, result: readRes.result });

  // 2. Write with capability — auto-allowed, dispatched.
  const writeRes = await gw.action('fs.write:notes/out.md', { content: 'edited by bot' });
  log(2, 'write notes/out.md', { decision: writeRes.decision, result: writeRes.result });

  // 3. Destructive action — policy routes to needs_approval (never auto-exec).
  const prop = await gw.action('shell.run', { cmd: 'deploy.sh' });
  log(3, 'propose shell.run (destructive)', {
    decision: prop.decision,
    approvalId: prop.approvalId,
    reason: prop.reason,
  });

  const approvalId = prop.approvalId;
  if (!approvalId) {
    console.log('No approval needed — exiting.');
    return;
  }

  // 4. Human-in-the-loop: list pending, then approve. In a real bot this is
  //    where an operator glances at the dashboard / an alert channel. Here we
  //    self-approve to demonstrate the full round-trip.
  const pending = await gw.pending();
  log(4, 'pending approvals', {
    pending: pending.pending.map((p) => ({ id: p.id, tool: p.tool, bot: p.bot, reason: p.reason })),
  });

  const approved = await gw.approve(approvalId);
  log(5, 'approved', { id: approved.id, status: approved.status, result: approved.result });

  // 5. Audit chain integrity.
  const verified = await gw.verify();
  log(6, 'audit chain verified', { ok: verified.ok, length: verified.length, head: verified.head });

  if (!verified.ok) {
    console.error('AUDIT CHAIN TAMPERED — aborting.');
    process.exit(1);
  }
  console.log('✓ demo complete — audit chain intact');
}

main().catch((err) => {
  console.error('bot failed:', err);
  process.exit(1);
});
