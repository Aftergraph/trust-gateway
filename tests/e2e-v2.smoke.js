'use strict';
// v2 end-to-end smoke against the LIVE gateway on :8800.
// Proves: SqlChain storage + chat proposal → SSE stream → operator approve →
// sealed execution, over real HTTP on the Tailscale IP.
const http = require('node:http');
const { GatewayClient } = require('../src/gateway/client');

const BASE = process.env.GATEWAY_URL || 'http://127.0.0.1:8800';
const FORGE = process.env.FORGE_TOKEN || 'fw-tok';
const ATLAS = process.env.ATLAS_TOKEN || 'at-tok';

const forge = new GatewayClient({ baseUrl: BASE, token: FORGE });
const atlas = new GatewayClient({ baseUrl: BASE, token: ATLAS });

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✖'} ${name}${extra ? '  → ' + extra : ''}`);
  if (!cond) failures++;
};

function sseCollect(token, seconds) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const req = http.get({
      host: u.hostname, port: u.port, path: '/v2/events?token=' + encodeURIComponent(token),
    }, (res) => {
      let buf = '';
      const frames = [];
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          frames.push(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      });
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, frames }); }, seconds * 1000);
    });
    req.on('error', reject);
  });
}

async function main() {
  const v = await atlas.verify();
  check('SqlChain live + migrated history intact', v.ok === true && v.length >= 15, `length=${v.length}, head=${v.head.slice(0, 12)}`);

  const pendingBefore = (await atlas.pending()).pending.length;

  // start SSE collector as atlas
  const sseP = sseCollect(ATLAS, 3.5);
  await new Promise((r) => setTimeout(r, 500));

  // chat proposal (destructive) via forge
  const c = await fetch(BASE + '/v2/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FORGE },
    body: JSON.stringify({ session: 'e2e-smoke', message: 'delete stale cache' }),
  }).then((r) => r.json());
  check('chat proposal → needs_approval', c.actions && c.actions[0] && c.actions[0].decision === 'needs_approval', c.reply);
  const aprId = c.actions[0].approvalId;

  // pending count grows
  const pendingAfter = (await atlas.pending()).pending.length;
  check('pending queue grew by 1', pendingAfter === pendingBefore + 1);

  // operator approves via SDK
  const ap = await atlas.approve(aprId);
  check('operator approve → executed', ap.status === 'approved' && ap.result && (ap.result.echoed === true || ap.result.done === true), JSON.stringify(ap.result || ap));

  // search finds the chat_action
  const s = await fetch(BASE + '/v2/search?q=chat_action&token=' + encodeURIComponent(ATLAS)).then((r) => r.json());
  check('search hits chat_action entries', s.total >= 2, `total=${s.total}`);

  // SSE captured the flow
  const { status, frames } = await sseP;
  const auditFrames = frames.filter((f) => f.startsWith('event: audit'));
  check('SSE authenticated (200 event-stream)', status === 200);
  check('SSE streamed the approval lifecycle', auditFrames.length >= 3, `${auditFrames.length} audit frames`);

  // chain still sealed
  const v2 = await atlas.verify();
  check('chain verifies after full flow', v2.ok === true, `length=${v2.length}`);

  console.log(failures === 0 ? '\n★ v2 E2E PASSED' : `\n✖ ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
