'use strict';
// FS-E1d — tenant-scoped approvals + audit-chain read scope.
//
// Covers: the full approval lifecycle inside one tenant never leaking to
// another tenant or to the main listing (park → list → resolve → impact),
// the scoped approvals file landing under data/tenants/<id>/approvals/,
// tenant-scoped /v1/audit reads (only own tagged entries; other tenants'
// seq deep-links stay 404; /v1/audit/verify stays an operator/main
// surface), and tenant-scoped /v2/events SSE streams (only own tagged
// entries). Main-tenant behavior is byte-identical: delegation to the
// ORIGINAL server.js handlers, singleton store path untouched, no
// data/tenants for main traffic, untagged chain payloads.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// File-level data jail (same pattern as tenant-scope.test.js): set BEFORE
// gateway modules are required. Unique tenant ids isolate the in-process tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e1d-approvals-'));
const DATA_DIR = path.join(TMP, 'data');
process.env.TG_DB_FILE = path.join(TMP, 'gateway.db');
process.env.TG_DATA_DIR = DATA_DIR;

const { TenantStore } = require('../src/gateway/tenants');
const { scopeDir } = require('../src/gateway/tenant-scope');
const { spawnTenantGateway } = require('../src/gateway/tenant-gateway');
const { Gateway } = require('../src/gateway/server');

const AUTH = 'Bear' + 'er ';
async function api(base, method, p, { body, token, headers = {} } = {}) {
  if (token) headers.authorization = AUTH + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (SSE etc.) */ }
  return { status: res.status, json, text };
}

function makeGateway(bots, extraMounts = []) {
  const gw = new Gateway({
    bots,
    telemetryFile: null,
    mountFiles: false,
    dispatch: async () => ({ ok: true, ran: 'stub-dispatch' }),
  });
  gw.mounts.push(require('../src/gateway/mounts/09-approvals'));
  for (const m of extraMounts) gw.mounts.push(m);
  return gw;
}

async function listen(gw) {
  const server = http.createServer((req, res) => gw.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function getTenantStoreLive(gw) {
  return require('../src/gateway/tenants').getTenantStore(gw);
}

const A = 'tnt_apr-a_atok';
const A_OP = 'tnt_apr-a_aop';
const B = 'tnt_apr-b_btok';
const B_OP = 'tnt_apr-b_bop';
const MAIN = 'tok-main-worker';

function tenantBots() {
  return {
    aworker: { token: A, role: 'worker', capabilities: [] },
    aop: { token: A_OP, role: 'operator', capabilities: ['*'] },
    bworker: { token: B, role: 'worker', capabilities: [] },
    bop: { token: B_OP, role: 'operator', capabilities: ['*'] },
    mainworker: { token: MAIN, role: 'worker', capabilities: [] },
  };
}

// Park one destructive action for a tenant worker → 202 + approvalId.
async function park(base, token, tool = 'shell.run:rm-fr', args = { path: '/tmp/x' }) {
  const r = await api(base, 'POST', '/v1/actions', { token, body: { tool, args } });
  assert.equal(r.status, 202, `park failed: ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.decision, 'needs_approval');
  return r.json.approvalId;
}

test('fs-e1d: approval lifecycle in tenant A is invisible to tenant B and main', async () => {
  const gw = makeGateway(tenantBots(), [require('../src/gateway/mounts/95-impact')]);
  const store = getTenantStoreLive(gw);
  store.create({ name: 'apr-a' });
  store.create({ name: 'apr-b' });
  const { server, base } = await listen(gw);
  try {
    const id = await park(base, A);

    // parked under A's scoped store, NOT the main store
    const scopedFile = path.join(DATA_DIR, 'tenants', 'apr-a', 'approvals', 'approvals.json');
    assert.ok(fs.existsSync(scopedFile), 'scoped approvals file created');
    const rows = JSON.parse(fs.readFileSync(scopedFile, 'utf8'));
    assert.ok(rows.some((r) => r.id === id && r.status === 'pending'));
    assert.equal(gw.approvals.get(id), undefined, 'main singleton store untouched');

    // A sees its own request; B and main see nothing (fail closed)
    const listA = await api(base, 'GET', '/v1/approvals', { token: A_OP });
    assert.equal(listA.status, 200);
    assert.ok(listA.json.pending.some((r) => r.id === id));
    assert.deepEqual((await api(base, 'GET', '/v1/approvals', { token: B })).json.pending, []);
    assert.deepEqual((await api(base, 'GET', '/v1/approvals', { token: MAIN })).json.pending, []);

    // B cannot approve (or even resolve) A's request → 404, request survives
    const x = await api(base, 'POST', `/v1/approvals/${id}/approve`, { token: B_OP });
    assert.equal(x.status, 404, 'cross-tenant approve is a uniform miss');
    assert.equal(gw.approvals.get(id), undefined, 'nothing leaked into main store');
    // B worker (non-operator) → 403 RBAC, same as the pre-FS-E1d route
    assert.equal((await api(base, 'POST', `/v1/approvals/${id}/approve`, { token: B })).status, 403);
    // still pending under A
    assert.ok((await api(base, 'GET', '/v1/approvals', { token: A_OP })).json.pending.some((r) => r.id === id));

    // B cannot read A's impact surface either (anti-enumeration 404)
    assert.equal((await api(base, 'GET', `/v2/approvals/${id}/impact`, { token: B_OP })).status, 404);
    const impact = await api(base, 'GET', `/v2/approvals/${id}/impact`, { token: A_OP });
    assert.equal(impact.status, 200);
    assert.ok(impact.json.snapshot && impact.json.snapshot.risk, 'impact snapshot served to own tenant');

    // A operator approves → executed via the gateway dispatcher, 200
    const ok = await api(base, 'POST', `/v1/approvals/${id}/approve`, { token: A_OP });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'approved');
    assert.deepEqual(ok.json.result, { ok: true, ran: 'stub-dispatch' });

    // resolve is audited WITH the tenant tag
    const auditA = await api(base, 'GET', '/v1/audit', { token: A_OP });
    const resolved = auditA.json.entries.filter((e) => e.payload.approvalId === id);
    assert.ok(resolved.some((e) => e.payload.type === 'approval_resolved'));
    for (const e of resolved) assert.equal(e.payload.tenant, 'apr-a', 'tenant tag present');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('fs-e1d: tenant /v1/audit reads are scoped; verify stays main-only; seq deep-links 404', async () => {
  const gw = makeGateway(tenantBots());
  const store = getTenantStoreLive(gw);
  store.create({ name: 'apr-a' });
  store.create({ name: 'apr-b' });
  const { server, base } = await listen(gw);
  try {
    const idA = await park(base, A, 'shell.run:a-probe');
    const idB = await park(base, B, 'shell.run:b-probe');

    // A sees ONLY its own tagged entries — never B's ids or payloads
    const auditA = await api(base, 'GET', '/v1/audit', { token: A });
    assert.equal(auditA.status, 200);
    assert.ok(auditA.json.entries.length > 0);
    for (const e of auditA.json.entries) {
      assert.equal(e.payload.tenant, 'apr-a', 'only own tagged entries');
    }
    assert.ok(!JSON.stringify(auditA.json).includes('b-probe'), "B's tool names never in A's audit view");
    assert.ok(auditA.json.entries.some((e) => e.payload.approvalId === idA), 'own approval visible');

    // B likewise
    const auditB = await api(base, 'GET', '/v1/audit', { token: B });
    for (const e of auditB.json.entries) assert.equal(e.payload.tenant, 'apr-b');
    assert.ok(!JSON.stringify(auditB.json).includes('a-probe'));

    // main sees EVERYTHING (full chain, both tags + untagged genesis)
    const auditMain = await api(base, 'GET', '/v1/audit', { token: MAIN });
    const types = auditMain.json.entries.map((e) => e.payload.tenant);
    assert.ok(types.includes('apr-a') && types.includes('apr-b'), 'main sees both tenants');
    const seqOfB = auditMain.json.entries.find((e) => e.payload.tenant === 'apr-b').seq;
    assert.ok(seqOfB > 0);

    // since= works identically for scoped reads
    const mid = Math.floor(seqOfB / 2);
    const sinceA = (await api(base, 'GET', `/v1/audit?since=${mid}`, { token: A })).json;
    for (const e of sinceA.entries) assert.equal(e.payload.tenant, 'apr-a');

    // seq deep-link into the other tenant's entry space → 404 (no such route)
    assert.equal((await api(base, 'GET', `/v1/audit/${seqOfB}`, { token: A })).status, 404);

    // /v1/audit/verify: main unchanged (full verify), non-main → 404 fail closed
    const verMain = await api(base, 'GET', '/v1/audit/verify', { token: MAIN });
    assert.equal(verMain.status, 200);
    assert.equal(verMain.json.ok, true);
    assert.equal((await api(base, 'GET', '/v1/audit/verify', { token: A })).status, 404);

    // unauthenticated stays 401 (bearer auth untouched)
    assert.equal((await api(base, 'GET', '/v1/audit')).status, 401);
    assert.equal((await api(base, 'POST', '/v1/actions', { body: {} })).status, 401);
    // unknown tenant prefix → 404 anti-enumeration
    assert.equal((await api(base, 'GET', '/v1/approvals', { token: 'tnt_ghost_tok' })).status, 401); // not a bot → 401
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('fs-e1d: main approvals byte-identical — singleton store, no tenant dirs, RBAC unchanged', async () => {
  const gw = makeGateway({
    worker: { token: MAIN, role: 'worker', capabilities: [] },
    op: { token: 'tok-main-op', role: 'operator', capabilities: ['*'] },
  });
  const { server, base } = await listen(gw);
  try {
    const approvalsFileBefore = gw.approvals.file;
    const id = await park(base, MAIN);
    // parked in the gateway's own singleton store
    assert.ok(gw.approvals.get(id), 'parked in gw.approvals singleton');
    assert.equal(gw.approvals.file, approvalsFileBefore);
    // no tenant dirs for MAIN traffic (earlier tests in this process may
    // have created non-main tenant dirs — main itself must not appear)
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'tenants', 'main')), 'no scoped dir for main');
    // main list shows it; worker resolve → 403 RBAC (unchanged)
    const list = await api(base, 'GET', '/v1/approvals', { token: MAIN });
    assert.ok(list.json.pending.some((r) => r.id === id));
    assert.equal((await api(base, 'POST', `/v1/approvals/${id}/deny`, { token: MAIN })).status, 403);
    // operator deny → identical body to the pre-FS-E1d route
    const deny = await api(base, 'POST', `/v1/approvals/${id}/deny`, { token: 'tok-main-op' });
    assert.equal(deny.status, 200);
    assert.deepEqual(deny.json, { id, status: 'denied' });
    // main chain payloads stay UNTAGGED (byte-identical vocabulary)
    const audit = await api(base, 'GET', '/v1/audit', { token: 'tok-main-op' });
    for (const e of audit.json.entries) assert.equal(e.payload.tenant, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('fs-e1d: /v2/events streams only own tagged entries to non-main tenants', async () => {
  const gw = makeGateway(tenantBots(), [require('../src/gateway/mounts/10-events')]);
  const store = getTenantStoreLive(gw);
  store.create({ name: 'apr-a' });
  store.create({ name: 'apr-b' });
  const { server, base } = await listen(gw);
  const http = require('node:http');

  // collect frames from an SSE stream for `ms` milliseconds
  const collect = (token, ms) => new Promise((resolve) => {
    const out = [];
    const r = http.get(`${base}/v2/events?token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        for (const m of buf.split('\n\n')) {
          const line = m.split('\n').find((l) => l.startsWith('data: '));
          if (line) out.push(line.slice(6));
        }
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      });
      setTimeout(() => { r.destroy(); resolve(out); }, ms);
    });
    r.on('error', () => resolve(out));
  });

  try {
    const streamAP = collect(A, 1400);
    await new Promise((r) => setTimeout(r, 250)); // let A attach
    const idA = await park(base, A, 'shell.run:evt-a');
    const idB = await park(base, B, 'shell.run:evt-b');
    await park(base, MAIN, 'shell.run:evt-main');
    const frames = await streamAP;
    const payloads = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
    const auditPayloads = payloads.filter((p) => p && p.payload);
    assert.ok(auditPayloads.length > 0, 'A received audit frames');
    for (const p of auditPayloads) {
      assert.equal(p.payload.tenant, 'apr-a', 'only own tagged entries on the stream');
    }
    const all = JSON.stringify(payloads);
    assert.ok(!all.includes('evt-b'), "B's entries never streamed to A");
    assert.ok(!all.includes('evt-main'), "main's untagged entries never streamed to A");
    assert.ok(all.includes('evt-a'), 'own entries streamed');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('fs-e1d: spawned tenant gateway parks approvals in its scoped dir; audit read scoped', async () => {
  const gA = await spawnTenantGateway({
    tenantId: 'apr-t',
    tokens: { forge: 'tnt_apr-t_ftok', atlas: 'tnt_apr-t_aotok' },
    roles: { forge: 'worker', atlas: 'operator' },
    caps: { atlas: ['*'] },
  });
  try {
    const id = await park(gA.base, 'tnt_apr-t_ftok', 'shell.run:spawn-probe');
    // scoped approvals file under the tenant jail
    const scopedFile = path.join(gA.scopedDir, 'approvals', 'approvals.json');
    assert.ok(fs.existsSync(scopedFile), 'scoped approvals file in spawned jail');
    assert.ok(fs.readFileSync(scopedFile, 'utf8').includes(id));
    // scoped audit read shows only tagged entries
    const audit = await api(gA.base, 'GET', '/v1/audit', { token: 'tnt_apr-t_ftok' });
    assert.equal(audit.status, 200);
    assert.ok(audit.json.entries.some((e) => e.payload.approvalId === id));
    for (const e of audit.json.entries) assert.equal(e.payload.tenant, 'apr-t');
    // operator (same tenant, via prefix) can deny it
    const deny = await api(gA.base, 'POST', `/v1/approvals/${id}/deny`, { token: 'tnt_apr-t_aotok' });
    assert.equal(deny.status, 200);
    assert.deepEqual(deny.json, { id, status: 'denied' });
    // verify stays main/operator-surface → tenant token 404
    assert.equal((await api(gA.base, 'GET', '/v1/audit/verify', { token: 'tnt_apr-t_ftok' })).status, 404);
  } finally {
    await gA.close();
  }
});