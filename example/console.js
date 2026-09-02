'use strict';
// Operator console demo: drives chat + approval flow via GatewayClient SDK.
// Shows the governed loop: propose → approve → seal visible in audit.
//
// Usage:
//   GATEWAY_URL=http://127.0.0.1:8800 GATEWAY_TOKEN=tok-atlas node example/console.js

const { GatewayClient } = require('../src/gateway/client');

const BASE_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8800';
const TOKEN = process.env.GATEWAY_TOKEN || 'tok-atlas';

function log(step, label, data) {
  console.log(`\n[${step}] ${label}`);
  if (data !== undefined && data !== null) console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const gw = new GatewayClient({ baseUrl: BASE_URL, token: TOKEN });
  log(0, `Operator console demo — ${BASE_URL}`);

  // 1. Verify chain integrity before we start.
  const verified = await gw.verify();
  log(1, 'audit chain pre-check', { ok: verified.ok, length: verified.length });
  if (!verified.ok) {
    console.error('AUDIT CHAIN TAMPERED — aborting.');
    process.exit(1);
  }

  // 2. Propose a destructive action (needs approval).
  const prop = await gw.action('shell.run', { cmd: 'echo "deploy complete"' });
  log(2, 'propose shell.run', {
    decision: prop.decision,
    approvalId: prop.approvalId,
    reason: prop.reason,
  });

  const approvalId = prop.approvalId;
  if (!approvalId) {
    console.log('No approval needed — exiting.');
    return;
  }

  // 3. List pending approvals.
  const pending = await gw.pending();
  log(3, 'pending approvals', {
    count: pending.pending.length,
    items: pending.pending.map((p) => ({ id: p.id, tool: p.tool, bot: p.bot })),
  });

  // 4. Approve the action.
  const approved = await gw.approve(approvalId);
  log(4, 'approved', { id: approved.id, status: approved.status });

  // 5. Read audit entries to see the sealed chain.
  const audit = await gw.audit();
  log(5, 'audit entries', {
    total: audit.entries.length,
    lastType: audit.entries[audit.entries.length - 1]?.payload?.type,
    head: audit.head,
  });

  // 6. Search audit for our action.
  // Note: /v2/search requires ?token= query param; GatewayClient doesn't support it yet.
  // We'll use raw fetch for this one call.
  const searchUrl = `${BASE_URL}/v2/search?q=shell&token=${TOKEN}`;
  const searchRes = await fetch(searchUrl);
  const searchBody = await searchRes.json();
  log(6, 'search audit for "shell"', {
    hits: searchBody.hits.length,
    firstMatch: searchBody.hits[0]?.payload?.tool || null,
  });

  // 7. Final verification.
  const finalVerify = await gw.verify();
  log(7, 'final audit verification', { ok: finalVerify.ok, length: finalVerify.length });

  if (!finalVerify.ok) {
    console.error('AUDIT CHAIN BROKEN after operations — critical failure.');
    process.exit(1);
  }

  console.log('\n✓ Operator console demo complete — all seals intact');
}

main().catch((err) => {
  console.error('console demo failed:', err);
  process.exit(1);
});
